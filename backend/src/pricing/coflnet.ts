import { EventEmitter } from 'node:events';
import { fetch as undiciFetch, EnvHttpProxyAgent } from 'undici';

/**
 * Rate-limited client for Coflnet's public price API (https://sky.coflnet.com/api).
 *
 * Purpose: give MEDIAN flips a reference price for items our own sales history has not
 * covered yet. Lookups are queued and paced; callers never block on the network.
 *
 * Confirmed live on 2026-10-21 (swagger: https://sky.coflnet.com/api/swagger/v1/swagger.json):
 *
 *   GET /api/item/price/{itemTag}
 *     "Aggregated summary of item prices for the 2 last days; stackable items are reduced to a single item"
 *     -> {"min":430000000,"median":969259000,"mean":846677643.3,"mode":975000000,"volume":94.5,"max":2150000000}
 *     Unknown tag -> HTTP 400 {"slug":"item_not_found","message":"could not find the item with the tag `X`"}
 *     Known tag with no data (e.g. ATTRIBUTE_SHARD) -> 200 with all zeros.
 *     Filters are plain query parameters (swagger "deepObject", "?Reforge=Legendary&Rarity=EPIC"):
 *       ?Rarity=LEGENDARY            (values: rarity names or "Any")
 *       ?Stars=5  ?Recombobulated=true  ?PetLevel=100  ?Reforge=heroic  ?Skin=...  (see /api/filter/options?itemTag=X)
 *     An unknown filter name -> 400 {"slug":"unknown_filter"}.
 *   GET /api/item/price/{itemTag}/current?count=1
 *     -> {"sell":436100000.0,"buy":445000000.0,"available":1,"updatedAt":"...","isAh":true}
 *   GET /api/items/bazaar/tags -> ["MAGMA_CREAM", ...]
 *
 *   Tags: Hypixel item ids, except PET, RUNE and POTION which carry their type:
 *     PET_ENDER_DRAGON, RUNE_MUSIC (no level), POTION_SPEED.
 *     Enchanted books are ENCHANTMENT_<ENCHANT>_<LEVEL>, e.g. ENCHANTMENT_ULTIMATE_WISE_5.
 *
 *   Rate limit (response headers): x-rate-limit-limit: 1m / x-rate-limit-remaining: 99 (100 per minute)
 *     plus x-ratelimit-limit: 50 (short burst window). Responses are CDN cached 30 min
 *     (cache-control: public, max-age=1800), so repeated identical queries are cheap for them.
 *     Default pacing here: 40 requests/minute.
 *
 *   Attribution is required for public projects: https://sky.coflnet.com/wiki/api#attribution
 */

export interface ExternalPrice {
  median: number;
  min: number;
  max: number;
  /** Sales per day over the aggregation window. */
  volume: number;
  fetchedAt: number;
  source: 'coflnet';
}

export interface CoflnetOptions {
  baseUrl?: string;
  requestsPerMinute?: number;
  cacheTtlMs?: number;
  fetch?: typeof undiciFetch;
  /** Injected clock for tests. */
  now?: () => number;
  /** Max queued lookups; oldest are dropped beyond this. */
  maxQueue?: number;
}

interface PriceResponse { min: number; median: number; mean: number; mode: number; volume: number; max: number }

/** Map our decoded item to Coflnet's tag. Returns undefined when no single tag exists (multi-enchant books). */
export function coflnetTag(itemId: string, item: { pet?: { type: string }; enchants: Record<string, number>; runes?: Record<string, number>; raw?: Record<string, unknown> }): string | undefined {
  if (itemId === 'PET') return item.pet ? `PET_${item.pet.type.toUpperCase()}` : undefined;
  if (itemId === 'ENCHANTED_BOOK') {
    const e = Object.entries(item.enchants);
    if (e.length !== 1) return undefined;
    return `ENCHANTMENT_${e[0][0].toUpperCase()}_${e[0][1]}`;
  }
  if (itemId === 'RUNE' || itemId.endsWith('_RUNE')) {
    const r = item.runes ? Object.keys(item.runes) : [];
    return r.length ? `RUNE_${r[0].toUpperCase()}` : undefined;
  }
  if (itemId === 'POTION') {
    const p = item.raw?.potion;
    return typeof p === 'string' ? `POTION_${p.toUpperCase()}` : undefined;
  }
  return itemId;
}

export class CoflnetPrices extends EventEmitter {
  private readonly baseUrl: string;
  private readonly ttl: number;
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof undiciFetch;
  private readonly now: () => number;
  private readonly maxQueue: number;
  private readonly dispatcher = new EnvHttpProxyAgent();
  private readonly cache = new Map<string, ExternalPrice>();
  /** Keys queued, most recently requested at the end (served from the end). */
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight = false;
  private pausedUntil = 0;
  private nextAllowedAt = 0;

  public readonly stats = { requests: 0, errors: 0, cacheSize: 0, queueSize: 0, rateLimited: 0 };

  constructor(opts: CoflnetOptions = {}) {
    super();
    this.baseUrl = (opts.baseUrl ?? 'https://sky.coflnet.com/api').replace(/\/$/, '');
    this.ttl = opts.cacheTtlMs ?? 3_600_000;
    this.intervalMs = 60_000 / (opts.requestsPerMinute ?? 40);
    this.fetchImpl = opts.fetch ?? undiciFetch;
    this.now = opts.now ?? Date.now;
    this.maxQueue = opts.maxQueue ?? 2000;
  }

  private key(tag: string, rarity?: string): string {
    return rarity ? `${tag}|${rarity.toUpperCase()}` : tag;
  }

  /** Cached value or undefined. Never blocks. Expired entries are returned as undefined and re-queued. */
  get(itemTag: string, rarity?: string): ExternalPrice | undefined {
    const k = this.key(itemTag, rarity);
    const v = this.cache.get(k);
    if (!v) return undefined;
    if (this.now() - v.fetchedAt > this.ttl) {
      this.enqueue(k);
      return undefined;
    }
    return v;
  }

  /** Non-blocking: queue a lookup unless cached and fresh. */
  request(itemTag: string, rarity?: string): void {
    const k = this.key(itemTag, rarity);
    const v = this.cache.get(k);
    if (v && this.now() - v.fetchedAt <= this.ttl) return;
    this.enqueue(k);
  }

  private enqueue(k: string): void {
    if (this.queued.has(k)) {
      // Move to the end so the most recently wanted item is served first.
      const i = this.queue.indexOf(k);
      if (i >= 0) this.queue.splice(i, 1);
    } else {
      this.queued.add(k);
    }
    this.queue.push(k);
    while (this.queue.length > this.maxQueue) {
      const dropped = this.queue.shift();
      if (dropped) this.queued.delete(dropped);
    }
    this.stats.queueSize = this.queue.length;
    this.schedule();
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (!this.running || this.timer || this.inFlight || this.queue.length === 0) return;
    const wait = Math.max(0, Math.max(this.nextAllowedAt, this.pausedUntil) - this.now());
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, wait);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const k = this.queue.pop();
    if (k === undefined) return;
    this.queued.delete(k);
    this.stats.queueSize = this.queue.length;
    this.inFlight = true;
    this.nextAllowedAt = this.now() + this.intervalMs;
    try {
      await this.fetchOne(k);
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  private async fetchOne(k: string): Promise<void> {
    const [tag, rarity] = k.split('|');
    const url = `${this.baseUrl}/item/price/${encodeURIComponent(tag)}${rarity ? `?Rarity=${encodeURIComponent(rarity)}` : ''}`;
    this.stats.requests++;
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'skyflip/0.1' }, dispatcher: this.dispatcher } as never);
    } catch (e) {
      this.stats.errors++;
      this.emit('error', e);
      // Transient network failure: try again later rather than forgetting the item.
      this.pausedUntil = this.now() + 5_000;
      this.enqueue(k);
      return;
    }
    if (res.status === 429) {
      this.stats.rateLimited++;
      const ra = Number(res.headers.get('retry-after'));
      this.pausedUntil = this.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000);
      this.enqueue(k);
      return;
    }
    if (res.status === 400) {
      // item_not_found or unknown_filter: remember as "no data" so we never ask again this TTL.
      this.store(k, { median: 0, min: 0, max: 0, volume: 0, fetchedAt: this.now(), source: 'coflnet' });
      return;
    }
    if (!res.ok) {
      this.stats.errors++;
      this.pausedUntil = this.now() + 10_000;
      if (res.status >= 500) this.enqueue(k);
      return;
    }
    let body: PriceResponse;
    try {
      body = (await res.json()) as PriceResponse;
    } catch {
      this.stats.errors++;
      return;
    }
    const price: ExternalPrice = {
      median: Number(body.median) || 0,
      min: Number(body.min) || 0,
      max: Number(body.max) || 0,
      volume: Number(body.volume) || 0,
      fetchedAt: this.now(),
      source: 'coflnet',
    };
    this.store(k, price);
    this.emit('price', tag, rarity, price);
  }

  private store(k: string, p: ExternalPrice): void {
    this.cache.set(k, p);
    this.stats.cacheSize = this.cache.size;
  }
}
