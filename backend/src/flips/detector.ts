import type { Auction } from '../hypixel/types.js';
import { itemBytesOf } from '../hypixel/types.js';
import { decodeItemBytes, type ItemData } from '../nbt/decode.js';
import { buildKeys } from '../pricing/key.js';
import { netAfterFees } from '../pricing/tax.js';
import type { SalesBook, LowestBinBook, Estimate } from '../pricing/priceBook.js';
import type { AuctionEntry } from '../ingest/auctionPoller.js';
import { ruleItemId, ruleMatches, riskRank, type Settings, type Risk, type FlipKind, type RuleSubject } from './settings.js';

export type { FlipKind, Risk };

export interface Flip {
  uuid: string;
  kind: FlipKind;
  itemId: string;
  /** Id used for filter rules: PET_<TYPE>, BOOK_<ench>_<lvl>, otherwise itemId. */
  ruleId: string;
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
  /** Lowest other active BIN per unit for the same key, when known. */
  lowestBin?: number;
  /** Median of recent sales per unit, when known. */
  median?: number;
  /** Where the median came from. */
  priceSource: 'sales' | 'coflnet' | 'none';
  /** Comparable sales per day. */
  salesPerDay: number;
  /** Key tier the reference came from. */
  keyTier: number;
  key: string;
  risk: Risk;
  /** True when a whitelist rule forced this flip through. */
  whitelisted: boolean;
  seller: string;
  /** ms between the API snapshot time and our detection: how late we are. */
  latencyMs: number;
  apiLastUpdated: number;
  detectedAt: number;
  /** ms since the auction was created, per the API. */
  ageMs: number;
  /** Auction end time (ms epoch). */
  end: number;
  command: string;
  /** Short, decoded summary of value-relevant modifiers for display. */
  summary: string;
  /** Item lore lines with Minecraft colour codes, for hover display. */
  lore: string[];
}

/** External (Coflnet) reference price adapter; wired in main. Must never block. */
export interface ExternalPriceLookup {
  lookup(item: ItemData, rarity: string): { median: number; volumePerDay: number } | undefined;
}

export interface DetectorContext {
  sales: SalesBook;
  lowestBin: LowestBinBook;
  settings: Settings;
  external?: ExternalPriceLookup;
}

/** Build the one-line modifier summary shown in the UI and the mod. */
export function summarize(item: ItemData): string {
  const bits: string[] = [];
  if (item.pet) bits.push(`Lvl ${item.pet.level}${item.pet.heldItem ? ' +' + item.pet.heldItem.replace(/^PET_ITEM_/, '') : ''}${item.pet.skin ? ' skin' : ''}`);
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

function riskOf(tier: number, perDay: number, profitPercent: number, source: Flip['priceSource']): Risk {
  if (source === 'none') return profitPercent > 1 ? 'HIGH' : 'MEDIUM';
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
  const rarity = item.rarity ?? a.tier;
  const ruleId = ruleItemId(item.id, item.pet?.type, keys[keys.length - 1]);

  // Cheap pre-filter: an item-only blacklist rule with no other conditions can drop before pricing.
  for (const r of s.blacklist) {
    if (r.item && Object.keys(r).every((k) => k === 'item' || k === 'note') && ruleMatchesItemOnly(r.item, ruleId)) return null;
  }

  // ---- reference prices (per unit) ----
  let est: Estimate | undefined = ctx.sales.estimate(keys, now);
  let priceSource: Flip['priceSource'] = est ? 'sales' : 'none';
  if (!est && ctx.external) {
    const ext = ctx.external.lookup(item, rarity);
    if (ext && ext.median > 0) {
      // Coflnet's per-tag median ignores most modifiers, so treat it like our tier-3 (id+rarity) price.
      est = { price: Math.floor(ext.median * 0.85), low: Math.floor(ext.median * 0.75), volume: Math.round(ext.volumePerDay), perDay: ext.volumePerDay, tier: 3, key: keys[3] };
      priceSource = 'coflnet';
    }
  }

  let others = ctx.lowestBin.othersOf(keys[0], a.uuid);
  let lbinTier = 0;
  if (others.length === 0) { others = ctx.lowestBin.othersOf(keys[1], a.uuid).map((p) => Math.floor(p * 0.96)); lbinTier = 1; }
  const lbin = others.length ? { price: others[0], tier: lbinTier, depth: others.length } : undefined;

  let best: { kind: FlipKind; target: number; tier: number; key: string } | undefined;
  if (s.kinds.SNIPE && lbin) {
    const enoughDepth = lbin.depth >= 2 || (est !== undefined && est.tier <= 3);
    const plausible = !est || lbin.price <= est.price * 1.6;
    if (enoughDepth && plausible) best = { kind: 'SNIPE', target: lbin.price, tier: lbin.tier, key: keys[lbin.tier] };
  }
  if (s.kinds.MEDIAN && est) {
    const target = lbin ? Math.min(est.price, lbin.price) : est.price;
    if (!best || target > best.target) best = { kind: 'MEDIAN', target, tier: est.tier, key: est.key };
  }
  if (!best) return null;

  const targetTotal = Math.floor(best.target * item.count);
  const profit = netAfterFees(targetTotal) - price;
  const profitPercent = profit / price;
  if (profit <= 0) return null;
  const perDay = est?.perDay ?? 0;
  const risk = riskOf(best.tier, perDay, profitPercent, priceSource);

  // ---- rules ----
  const subject: RuleSubject = { item: ruleId, rarity, kind: best.kind, price, profit, profitPercent, salesPerDay: perDay, risk };
  for (const r of s.blacklist) if (ruleMatches(r, subject, 'blacklist')) return null;
  const whitelisted = s.whitelist.some((r) => ruleMatches(r, subject, 'whitelist'));
  if (s.whitelistOnly && !whitelisted) return null;

  if (!whitelisted) {
    if (profit < s.minProfit || profitPercent < s.minProfitPercent) return null;
    if (best.tier > s.maxKeyTier) return null;
    if (riskRank(risk) > riskRank(s.maxRisk)) return null;
    if (best.kind === 'MEDIAN' && perDay < s.minSalesPerDay) return null;
    // Without any reference history, a 4000% "flip" is almost always two bogus listings propping each other up.
    if (priceSource === 'none' && profitPercent > 3) return null;
  }

  return {
    uuid: a.uuid,
    kind: best.kind,
    itemId: item.id,
    ruleId,
    itemName: item.name || a.item_name,
    rarity,
    count: item.count,
    price,
    target: targetTotal,
    profit,
    profitPercent,
    lowestBin: lbin?.price,
    median: est?.price,
    priceSource,
    salesPerDay: Math.round(perDay * 10) / 10,
    keyTier: best.tier,
    key: best.key,
    risk,
    whitelisted,
    seller: a.auctioneer,
    latencyMs: now - apiLastUpdated,
    apiLastUpdated,
    detectedAt: now,
    ageMs: Math.max(0, apiLastUpdated - a.start),
    end: a.end,
    command: `/viewauction ${a.uuid}`,
    summary: summarize(item),
    lore: a.item_lore ? a.item_lore.split('\n') : item.lore,
  };
}

function ruleMatchesItemOnly(pattern: string, item: string): boolean {
  return pattern.endsWith('*') ? item.startsWith(pattern.slice(0, -1)) : pattern === item;
}
