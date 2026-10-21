import { EventEmitter } from 'node:events';
import type { BazaarFilter, BazaarFlip, BazaarOptions, BazaarProduct, BazaarResponse, BazaarRisk } from './types.js';

export type { BazaarFilter, BazaarFlip, BazaarOptions, BazaarRisk } from './types.js';

const HOURS_PER_WEEK = 168;
const RISK_RANK: Record<BazaarRisk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Minimal client surface so tests can stub the API. HypixelClient satisfies it. */
export interface BazaarClient {
  get<T>(path: string): Promise<T>;
}

/** ENCHANTED_LAPIS_LAZULI_BLOCK -> "Enchanted Lapis Lazuli Block"; INK_SACK:4 -> "Ink Sack 4". */
export function productName(id: string): string {
  return id
    .replace(/:/g, '_')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Finds bazaar order flips: place a buy order just above the best bid, wait for it to fill,
 * then list a sell offer just below the best ask. Profit is the spread minus the sell tax.
 *
 * Recomputed only when Hypixel's `lastUpdated` changes (every ~20-60 s). Everything is a
 * single pass over ~2000 products with no per-product allocation beyond the result object.
 */
export class BazaarService extends EventEmitter {
  public lastUpdated = 0;
  public productCount = 0;
  private flips: BazaarFlip[] = [];
  private running = false;
  private readonly taxRate: number;
  private readonly maxUnitsPerHour: number;

  constructor(private readonly client: BazaarClient, opts: BazaarOptions = {}) {
    super();
    this.taxRate = opts.taxRate ?? 0.0125;
    this.maxUnitsPerHour = opts.maxUnitsPerHour ?? 5000;
  }

  /** Fetch once. Returns false when Hypixel's snapshot has not changed since the last poll. */
  async pollOnce(): Promise<boolean> {
    const res = await this.client.get<BazaarResponse>('/skyblock/bazaar');
    if (!res?.success || !res.products) return false;
    if (res.lastUpdated <= this.lastUpdated) return false;
    this.lastUpdated = res.lastUpdated;
    this.productCount = Object.keys(res.products).length;
    this.flips = this.analyze(res.products);
    this.emit('update', this.flips);
    return true;
  }

  async run(intervalMs = 20_000): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.emit('error', e);
      }
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.running = false;
  }

  /** All current flips, best profit/hour first. */
  all(): BazaarFlip[] {
    return this.flips;
  }

  /** Filtered view, sorted by profitPerHour descending. */
  top(filter: BazaarFilter = {}): BazaarFlip[] {
    const maxRisk = filter.risk !== undefined ? RISK_RANK[filter.risk] : 2;
    const out: BazaarFlip[] = [];
    const limit = filter.limit ?? 50;
    for (const f of this.flips) {
      if (filter.minProfitPerHour !== undefined && f.profitPerHour < filter.minProfitPerHour) continue;
      if (filter.minProfitPercent !== undefined && f.profitPercent < filter.minProfitPercent) continue;
      if (filter.maxPrice !== undefined && filter.maxPrice > 0 && f.buyOrderPrice > filter.maxPrice) continue;
      if (filter.minVolumeWeek !== undefined && Math.min(f.buyMovingWeek, f.sellMovingWeek) < filter.minVolumeWeek) continue;
      if (RISK_RANK[f.risk] > maxRisk) continue;
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Exposed for tests: compute flips from a products map. */
  analyze(products: Record<string, BazaarProduct>): BazaarFlip[] {
    const out: BazaarFlip[] = [];
    for (const id in products) {
      const f = this.evaluate(products[id]);
      if (f) out.push(f);
    }
    out.sort((a, b) => b.profitPerHour - a.profitPerHour);
    return out;
  }

  private evaluate(p: BazaarProduct): BazaarFlip | null {
    // buy_summary = sell offers (lowest first); sell_summary = buy orders (highest first).
    const asks = p.buy_summary;
    const bids = p.sell_summary;
    if (!asks || !bids || asks.length === 0 || bids.length === 0) return null;
    const instaBuy = asks[0].pricePerUnit;
    const instaSell = bids[0].pricePerUnit;
    if (!(instaBuy > 0) || !(instaSell > 0)) return null;

    const buyOrderPrice = round1(instaSell + 0.1);
    const sellOrderPrice = round1(instaBuy - 0.1);
    const spread = sellOrderPrice - buyOrderPrice;
    if (spread <= 0) return null;
    const profitPerUnit = spread - sellOrderPrice * this.taxRate;
    if (profitPerUnit <= 0) return null;

    const q = p.quick_status;
    const buyMovingWeek = q?.buyMovingWeek ?? 0;
    const sellMovingWeek = q?.sellMovingWeek ?? 0;
    const thinSide = Math.min(buyMovingWeek, sellMovingWeek);
    if (thinSide <= 0) return null;

    // Two stale orders far apart on a dead item is not a market.
    if (spread > 2 * buyOrderPrice && thinSide < 1000) return null;

    const unitsPerHour = thinSide / HOURS_PER_WEEK;
    const profitPerHour = profitPerUnit * Math.min(unitsPerHour, this.maxUnitsPerHour);
    const profitPercent = profitPerUnit / buyOrderPrice;
    const spreadRatio = spread / buyOrderPrice;

    // Units you would move in a day at the capped rate; a LOW-risk market absorbs 10x that weekly on both sides.
    const unitsPerDay = Math.min(unitsPerHour, this.maxUnitsPerHour) * 24;
    let risk: BazaarRisk;
    if (spreadRatio > 0.5 || thinSide < 1000) risk = 'HIGH';
    else if (spreadRatio < 0.25 && buyMovingWeek >= 10 * unitsPerDay && sellMovingWeek >= 10 * unitsPerDay) risk = 'LOW';
    else risk = 'MEDIUM';

    const name = productName(p.product_id ?? q?.productId ?? '');
    return {
      productId: p.product_id ?? q.productId,
      name,
      buyOrderPrice,
      sellOrderPrice,
      instaBuy,
      instaSell,
      spread,
      profitPerUnit,
      profitPercent,
      buyMovingWeek,
      sellMovingWeek,
      unitsPerHour,
      profitPerHour,
      buyOrders: q?.buyOrders ?? 0,
      sellOrders: q?.sellOrders ?? 0,
      command: `/bz ${name}`,
      risk,
    };
  }
}
