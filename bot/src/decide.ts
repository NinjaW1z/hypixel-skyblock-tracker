import type { BotConfig } from './config.js';
import type { Flip, Purchase } from './types.js';

export interface DecisionContext {
  cfg: BotConfig['buy'];
  now: number;
  /** Coins in the purse when known. */
  purse?: number;
  /** Purchases not yet sold (including ones still being claimed/listed). */
  open: Purchase[];
  /** Timestamps and prices of recent buys (last hour is enough). */
  recentBuys: { ts: number; price: number; cycle: number }[];
  /** Last buy time per item id. */
  lastBuyByItem: Map<string, number>;
  /** Auction ids already bought or attempted. */
  seen: Set<string>;
  /** Current API cycle id (apiLastUpdated of the flip). */
  cycle: number;
  paused: boolean;
}

export interface Decision { buy: boolean; reason: string }

/**
 * Pure bot-side safety net. The backend already decided the flip is worth buying; this only
 * protects the account: purse, spend caps, duplicates, stale flips.
 */
export function decide(f: Flip, ctx: DecisionContext): Decision {
  const c = ctx.cfg;
  const no = (reason: string): Decision => ({ buy: false, reason });
  if (ctx.paused) return no('paused');
  if (ctx.seen.has(f.uuid)) return no('already attempted');
  if (!f.command?.startsWith('/viewauction')) return no('not a BIN auction');
  if (!(f.price > 0)) return no('no price');
  if (c.maxPrice > 0 && f.price > c.maxPrice) return no(`price ${f.price} > maxPrice ${c.maxPrice}`);
  const age = ctx.now - f.detectedAt;
  if (age > c.maxAgeMs && !(f.purchaseAt && f.purchaseAt > ctx.now)) return no(`stale: ${age}ms since detection`);
  if (f.end && f.end < ctx.now + 2_000) return no('auction ending');
  if (ctx.purse !== undefined && ctx.purse - f.price < c.purseReserve) return no(`purse ${ctx.purse} - ${f.price} < reserve ${c.purseReserve}`);
  if (c.maxOpenFlips > 0 && ctx.open.length >= c.maxOpenFlips) return no(`${ctx.open.length} flips still open (max ${c.maxOpenFlips})`);
  const hourAgo = ctx.now - 3_600_000;
  const lastHour = ctx.recentBuys.filter((b) => b.ts > hourAgo);
  if (c.maxBuysPerHour > 0 && lastHour.length >= c.maxBuysPerHour) return no(`${lastHour.length} buys in the last hour (max ${c.maxBuysPerHour})`);
  if (c.maxSpendPerHour > 0 && lastHour.reduce((a, b) => a + b.price, 0) + f.price > c.maxSpendPerHour) return no('hourly spend cap');
  const thisCycle = ctx.recentBuys.filter((b) => b.cycle === ctx.cycle).length;
  if (c.maxBuysPerCycle > 0 && thisCycle >= c.maxBuysPerCycle) return no(`${thisCycle} buys this cycle (max ${c.maxBuysPerCycle})`);
  const last = ctx.lastBuyByItem.get(f.ruleId || f.itemId);
  if (last !== undefined && ctx.now - last < c.itemCooldownMs) return no(`item cooldown (${Math.round((ctx.now - last) / 1000)}s ago)`);
  return { buy: true, reason: 'ok' };
}

/** Order candidates: highest profit first, ties by earlier purchaseAt. */
export function rankFlips(flips: Flip[]): Flip[] {
  return [...flips].sort((a, b) => (b.profit - a.profit) || ((a.purchaseAt ?? 0) - (b.purchaseAt ?? 0)));
}

/** Hypixel's BIN listing fee: 1 % under 10M, 2 % from 10M, 3 % from 100M. */
export function listingFee(price: number): number {
  const rate = price >= 100_000_000 ? 0.03 : price >= 10_000_000 ? 0.02 : 0.01;
  return Math.floor(price * rate);
}
