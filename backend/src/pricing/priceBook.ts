import { KEY_TIERS } from './key.js';
import { trimmedMedian } from './stats.js';

export interface Sale { price: number; ts: number; bin: boolean }

export interface Estimate {
  /** Reference resale price per unit. */
  price: number;
  /** Conservative price (25th percentile) per unit. */
  low: number;
  /** Sales used. */
  volume: number;
  /** Sales per day over the window. */
  perDay: number;
  /** Key tier the estimate came from (0 = exact comparables). */
  tier: number;
  key: string;
}

/** Minimum sample size required to trust each key tier. */
const MIN_VOLUME = [3, 4, 5, 8, 15];
/** Haircut applied to coarser tiers because dropped modifiers usually add value to the comparables. */
const TIER_HAIRCUT = [1.0, 0.96, 0.9, 0.8, 0.65];
const MAX_PER_KEY = 120;

/**
 * In-memory history of sold prices per comparable key, at every tier.
 * Lookups are O(1) hash hits followed by a sort of at most MAX_PER_KEY numbers,
 * which keeps the hot path well under a millisecond per auction.
 */
export class SalesBook {
  private readonly byKey = new Map<string, Sale[]>();
  private readonly windowMs: number;
  public total = 0;

  constructor(historyDays: number) {
    this.windowMs = historyDays * 86_400_000;
  }

  record(keys: string[], price: number, ts: number, bin: boolean): void {
    this.total++;
    for (let t = 0; t < KEY_TIERS && t < keys.length; t++) {
      const k = keys[t];
      // Tiers collapse to the same key when an item has no modifiers at that level; count it once.
      if (t > 0 && k === keys[t - 1]) continue;
      let arr = this.byKey.get(k);
      if (!arr) { arr = []; this.byKey.set(k, arr); }
      arr.push({ price, ts, bin });
      if (arr.length > MAX_PER_KEY) arr.splice(0, arr.length - MAX_PER_KEY);
    }
  }

  private recent(key: string, now: number): Sale[] {
    const arr = this.byKey.get(key);
    if (!arr) return [];
    const cutoff = now - this.windowMs;
    // Sales arrive roughly in time order but not strictly (the ended feed is a 60s bucket and
    // history is reloaded from disk), so filter rather than trim a prefix.
    let expired = 0;
    for (const s of arr) if (s.ts < cutoff) expired++;
    if (expired === 0) return arr;
    const kept = arr.filter((s) => s.ts >= cutoff);
    this.byKey.set(key, kept);
    return kept;
  }

  /** Finest tier with enough volume. */
  estimate(keys: string[], now = Date.now()): Estimate | undefined {
    for (let t = 0; t < KEY_TIERS && t < keys.length; t++) {
      const sales = this.recent(keys[t], now);
      if (sales.length < MIN_VOLUME[t]) continue;
      const { median, p25 } = trimmedMedian(sales.map((s) => s.price));
      let oldest = now;
      for (const s of sales) if (s.ts < oldest) oldest = s.ts;
      // Floor the span at 6h so a burst of sales does not read as thousands per day.
      const span = Math.max(6 * 3_600_000, now - oldest);
      const perDay = (sales.length / span) * 86_400_000;
      return {
        price: Math.floor(median * TIER_HAIRCUT[t]),
        low: Math.floor(p25 * TIER_HAIRCUT[t]),
        volume: sales.length,
        perDay,
        tier: t,
        key: keys[t],
      };
    }
    return undefined;
  }

  /** Number of distinct keys tracked, for status output. */
  get size(): number { return this.byKey.size; }
}

interface BinEntry { uuid: string; price: number }

/**
 * Lowest active BIN per comparable key (tiers 0 and 1), rebuilt from each full snapshot.
 * Used for "snipe" flips: a new listing priced under the next-lowest BIN resells quickly.
 */
export class LowestBinBook {
  private byKey = new Map<string, BinEntry[]>();
  private next = new Map<string, BinEntry[]>();
  private readonly keep = 4;

  /** Begin assembling a new snapshot. */
  beginSnapshot(): void { this.next = new Map(); }

  add(keys: string[], uuid: string, unitPrice: number): void {
    for (let t = 0; t < 2 && t < keys.length; t++) {
      const k = keys[t];
      if (t > 0 && k === keys[t - 1]) continue;
      let arr = this.next.get(k);
      if (!arr) { arr = []; this.next.set(k, arr); }
      if (arr.length < this.keep) {
        arr.push({ uuid, price: unitPrice });
        arr.sort((a, b) => a.price - b.price);
      } else if (unitPrice < arr[arr.length - 1].price) {
        arr[arr.length - 1] = { uuid, price: unitPrice };
        arr.sort((a, b) => a.price - b.price);
      }
    }
  }

  /** Make the assembled snapshot live. */
  commit(): void { this.byKey = this.next; }

  /** Lowest BIN for a key that is not the given auction. */
  lowestOther(key: string, excludeUuid: string): BinEntry | undefined {
    const arr = this.byKey.get(key);
    if (!arr) return undefined;
    for (const e of arr) if (e.uuid !== excludeUuid) return e;
    return undefined;
  }

  /** Up to `keep` cheapest other BIN unit prices for a key, ascending. */
  othersOf(key: string, excludeUuid: string): number[] {
    const arr = this.byKey.get(key);
    if (!arr) return [];
    const out: number[] = [];
    for (const e of arr) if (e.uuid !== excludeUuid) out.push(e.price);
    return out;
  }

  get size(): number { return this.byKey.size; }
}
