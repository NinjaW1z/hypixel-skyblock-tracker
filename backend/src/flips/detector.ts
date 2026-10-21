import type { Auction } from '../hypixel/types.js';
import { itemBytesOf } from '../hypixel/types.js';
import { decodeItemBytes, type ItemData } from '../nbt/decode.js';
import { buildKeys } from '../pricing/key.js';
import type { AuctionEntry } from '../ingest/auctionPoller.js';
import { netAfterFees } from '../pricing/tax.js';
import type { SalesBook, LowestBinBook, Estimate } from '../pricing/priceBook.js';
import type { Settings } from './settings.js';

export type FlipKind = 'SNIPE' | 'MEDIAN';
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Flip {
  uuid: string;
  kind: FlipKind;
  itemId: string;
  itemName: string;
  rarity: string;
  count: number;
  /** Total purchase price (whole stack). */
  price: number;
  /** Expected resale price (whole stack), before fees. */
  target: number;
  /** target - fees - price. */
  profit: number;
  /** profit / price. */
  profitPercent: number;
  /** Second-lowest active BIN per unit for the same key, when known. */
  lowestBin?: number;
  /** Median of recent sales per unit, when known. */
  median?: number;
  /** Comparable sales per day. */
  salesPerDay: number;
  /** Key tier the reference came from. */
  keyTier: number;
  key: string;
  risk: Risk;
  seller: string;
  /** ms between the API snapshot time and our detection: how late we are. */
  latencyMs: number;
  apiLastUpdated: number;
  detectedAt: number;
  /** ms since the auction was created, per the API. */
  ageMs: number;
  command: string;
  /** Short, decoded summary of value-relevant modifiers for display. */
  summary: string;
}

export interface DetectorContext {
  sales: SalesBook;
  lowestBin: LowestBinBook;
  settings: Settings;
}

/** Build the one-line modifier summary shown in the UI and the mod. */
export function summarize(item: ItemData): string {
  const bits: string[] = [];
  if (item.pet) bits.push(`Lvl ${item.pet.level}${item.pet.heldItem ? ' +' + item.pet.heldItem : ''}${item.pet.skin ? ' skin' : ''}`);
  if (item.stars) bits.push(`${item.stars}★`);
  if (item.recombobulated) bits.push('Recomb');
  if (item.reforge) bits.push(item.reforge);
  if (item.hotPotato) bits.push(`HPB${item.hotPotato}`);
  const ult = Object.entries(item.enchants).find(([n]) => n.startsWith('ultimate_'));
  if (ult) bits.push(`${ult[0].slice(9)} ${ult[1]}`);
  if (item.gems.length) bits.push(`${item.gems.length} gems`);
  const attrs = Object.entries(item.attributes);
  if (attrs.length) bits.push(attrs.map(([n, l]) => `${n} ${l}`).join(', '));
  if (item.skin) bits.push(`skin ${item.skin}`);
  if (item.artOfWar) bits.push('AoW');
  if (item.count > 1) bits.push(`x${item.count}`);
  return bits.join(' · ');
}

function riskOf(tier: number, perDay: number, profitPercent: number): Risk {
  if (tier <= 1 && perDay >= 3 && profitPercent < 2) return 'LOW';
  if (tier <= 2 && perDay >= 1 && profitPercent < 5) return 'MEDIUM';
  return 'HIGH';
}

/** Decode an auction into an entry; convenience for callers outside the poller (tests, replay). */
export function toEntry(a: Auction): AuctionEntry {
  const item = decodeItemBytes(itemBytesOf(a));
  return { auction: a, item, keys: buildKeys(item, item.rarity ?? a.tier), unitPrice: a.starting_bid / item.count };
}

/**
 * Evaluate a freshly listed auction. Returns a Flip when it clears the user's thresholds.
 * Runs in the hot path for every new auction in every snapshot, so no I/O or decoding here.
 */
export function evaluateAuction(entry: AuctionEntry, ctx: DetectorContext, apiLastUpdated: number, now = Date.now()): Flip | null {
  const { auction: a, item, keys } = entry;
  if (!a.bin || a.claimed) return null;
  if (a.highest_bid_amount > 0 && a.highest_bid_amount >= a.starting_bid) return null; // already bought
  const price = a.starting_bid;
  if (!(price > 0)) return null;
  const s = ctx.settings;
  if (s.maxPrice > 0 && price > s.maxPrice) return null;
  if (s.blacklist.length && s.blacklist.includes(item.id)) return null;
  if (s.whitelist.length && !s.whitelist.includes(item.id)) return null;
  const rarity = item.rarity ?? a.tier;

  const est: Estimate | undefined = s.kinds.MEDIAN || s.kinds.SNIPE ? ctx.sales.estimate(keys, now) : undefined;

  // Other active BINs for the same item, cheapest first. Prefer exact comparables, fall back to tier 1.
  let others = ctx.lowestBin.othersOf(keys[0], a.uuid);
  let lbinTier = 0;
  if (others.length === 0) { others = ctx.lowestBin.othersOf(keys[1], a.uuid).map((p) => Math.floor(p * 0.96)); lbinTier = 1; }
  const lbin = others.length ? { price: others[0], tier: lbinTier, depth: others.length } : undefined;

  // Candidate targets (per unit).
  let best: { kind: FlipKind; target: number; tier: number; key: string } | undefined;

  if (s.kinds.SNIPE && lbin) {
    // One other listing is not a market: a single overpriced BIN would make anything look like a flip.
    // With sold history we can sanity-check against the median instead.
    const enoughDepth = lbin.depth >= 2 || (est !== undefined && est.tier <= 2);
    // A lowest-BIN far above the sold median is a manipulated market; ignore it.
    const plausible = !est || lbin.price <= est.price * 1.6;
    if (enoughDepth && plausible) best = { kind: 'SNIPE', target: lbin.price, tier: lbin.tier, key: keys[lbin.tier] };
  }
  if (s.kinds.MEDIAN && est && est.tier <= s.maxKeyTier && est.perDay >= s.minSalesPerDay) {
    // If a cheaper BIN already sits on the market you must undercut it; target the lower of the two.
    const target = lbin ? Math.min(est.price, lbin.price) : est.price;
    if (!best || target > best.target) best = { kind: 'MEDIAN', target, tier: est.tier, key: est.key };
  }
  if (!best) return null;
  if (best.tier > s.maxKeyTier) return null;

  const targetTotal = Math.floor(best.target * item.count);
  const profit = netAfterFees(targetTotal) - price;
  const profitPercent = profit / price;
  if (profit < s.minProfit || profitPercent < s.minProfitPercent) return null;
  // Without sold history, a 4000% "flip" is almost always two bogus listings propping each other up.
  if (!est && profitPercent > 3) return null;

  const perDay = est?.perDay ?? 0;
  return {
    uuid: a.uuid,
    kind: best.kind,
    itemId: item.id,
    itemName: item.name || a.item_name,
    rarity,
    count: item.count,
    price,
    target: targetTotal,
    profit,
    profitPercent,
    lowestBin: lbin?.price,
    median: est?.price,
    salesPerDay: Math.round(perDay * 10) / 10,
    keyTier: best.tier,
    key: best.key,
    risk: riskOf(best.tier, perDay, profitPercent),
    seller: a.auctioneer,
    latencyMs: now - apiLastUpdated,
    apiLastUpdated,
    detectedAt: now,
    ageMs: Math.max(0, apiLastUpdated - a.start),
    command: `/viewauction ${a.uuid}`,
    summary: summarize(item),
  };
}
