import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { log, sleep } from '../util/log.js';
import type { HypixelClient } from '../hypixel/client.js';
import type { Auction, AuctionsPage } from '../hypixel/types.js';
import { itemBytesOf } from '../hypixel/types.js';
import { decodeItemBytes, type ItemData } from '../nbt/decode.js';
import { buildKeys } from '../pricing/key.js';
import type { LowestBinBook } from '../pricing/priceBook.js';

export interface CycleStats {
  lastUpdated: number;
  /** ms from the API timestamp to our detection of the refresh. */
  detectLagMs: number;
  /** ms from detection to the last page processed. */
  fetchMs: number;
  pages: number;
  totalAuctions: number;
  newAuctions: number;
  /** Observed interval between the last two refreshes. */
  intervalMs: number;
}

/** A listing together with its decoded item and comparable keys, decoded exactly once. */
export interface AuctionEntry {
  auction: Auction;
  item: ItemData;
  keys: string[];
  unitPrice: number;
}

export interface AuctionPollerEvents {
  /** Fired per page, as early as possible, with the auctions not seen in the previous snapshot. */
  newAuctions: (entries: AuctionEntry[], lastUpdated: number) => void;
  /** Fired once per completed snapshot. */
  cycle: (s: CycleStats) => void;
  error: (e: unknown) => void;
}

/**
 * Tracks the Hypixel auction cache and surfaces new listings within milliseconds of a refresh.
 *
 * Strategy:
 *  1. Learn the refresh cadence from the lastUpdated stamps (nominally 60s).
 *  2. Sleep until just before the predicted refresh, then probe page 0 every ~120ms.
 *  3. The instant lastUpdated changes, fan out every other page concurrently over the
 *     keep-alive pool and emit new auctions page-by-page without waiting for the full set.
 *  4. Rebuild the lowest-BIN index from the full snapshot for the next cycle.
 */
export class AuctionPoller extends EventEmitter {
  /**
   * Decoded items for every auction in the current snapshot. Listings never change while
   * active, so an entry is decoded once and carried forward; each cycle only pays for new ids.
   */
  private cache = new Map<string, AuctionEntry | null>();
  private lastUpdated = 0;
  private intervalMs = config.refreshIntervalMs;
  private running = false;

  constructor(private readonly client: HypixelClient, private readonly lowestBin: LowestBinBook) {
    super();
  }

  override on<K extends keyof AuctionPollerEvents>(ev: K, fn: AuctionPollerEvents[K]): this { return super.on(ev, fn); }
  override emit<K extends keyof AuctionPollerEvents>(ev: K, ...args: Parameters<AuctionPollerEvents[K]>): boolean {
    return super.emit(ev, ...args);
  }

  get snapshotLastUpdated(): number { return this.lastUpdated; }
  get activeCount(): number { return this.cache.size; }

  stop(): void { this.running = false; }

  async run(): Promise<void> {
    this.running = true;
    // Initial snapshot: populate state silently.
    while (this.running) {
      try {
        const p0 = await this.client.auctionsPage(0);
        await this.consumeSnapshot(p0, Date.now(), false);
        break;
      } catch (e) {
        this.emit('error', e);
        await sleep(2_000);
      }
    }
    while (this.running) {
      try {
        await this.waitForRefresh();
      } catch (e) {
        this.emit('error', e);
        await sleep(1_000);
      }
    }
  }

  private async waitForRefresh(): Promise<void> {
    const predicted = this.lastUpdated + this.intervalMs;
    const lead = predicted - config.preRefreshLeadMs - Date.now();
    if (lead > 0) await sleep(lead);

    // Probe page 0 until it carries a newer lastUpdated.
    let probes = 0;
    for (;;) {
      if (!this.running) return;
      const t = Date.now();
      let p0: AuctionsPage;
      try {
        p0 = await this.client.auctionsPage(0);
      } catch (e) {
        this.emit('error', e);
        await sleep(500);
        continue;
      }
      probes++;
      if (p0.lastUpdated > this.lastUpdated) {
        const prev = this.lastUpdated;
        const observed = p0.lastUpdated - prev;
        // Smooth the cadence estimate; ignore outliers from downtime.
        if (observed > 20_000 && observed < 180_000) this.intervalMs = Math.round(this.intervalMs * 0.6 + observed * 0.4);
        log.debug(`refresh detected after ${probes} probes, lag ${Date.now() - p0.lastUpdated}ms`);
        await this.consumeSnapshot(p0, t, true);
        return;
      }
      // Past the predicted time by a lot: back off slightly so we don't spam while Hypixel is late.
      const late = Date.now() - predicted;
      await sleep(late > 15_000 ? 500 : config.probeIntervalMs);
    }
  }

  /** Fetch all remaining pages for the snapshot described by page 0 and swap state. */
  private async consumeSnapshot(p0: AuctionsPage, detectedAt: number, emitNew: boolean): Promise<void> {
    const lu = p0.lastUpdated;
    const prev = this.cache;
    const next = new Map<string, AuctionEntry | null>();
    // An id missing from the previous snapshot is only "new" if it was also created recently.
    // Otherwise a page that failed to download last cycle would resurface its listings as flips.
    const newestAcceptableStart = this.lastUpdated - 2 * this.intervalMs;
    this.lowestBin.beginSnapshot();
    let newCount = 0;
    let total = 0;

    const handlePage = (p: AuctionsPage) => {
      const fresh: AuctionEntry[] = [];
      for (const a of p.auctions) {
        total++;
        let entry = prev.get(a.uuid);
        const isNew = entry === undefined;
        if (isNew) entry = this.decode(a);
        next.set(a.uuid, entry ?? null);
        if (!entry) continue;
        // Carry the latest auction object (bid/claimed state can change) but keep the decoded item.
        entry.auction = a;
        if (a.bin && !a.claimed) this.lowestBin.add(entry.keys, a.uuid, entry.unitPrice);
        if (emitNew && isNew && a.start >= newestAcceptableStart) fresh.push(entry);
      }
      if (fresh.length) {
        newCount += fresh.length;
        this.emit('newAuctions', fresh, lu);
      }
    };

    handlePage(p0);
    const pages = p0.totalPages;
    const tasks: Promise<void>[] = [];
    for (let i = 1; i < pages; i++) {
      tasks.push(
        this.client.auctionsPageFor(i, lu).then(handlePage, (e) => { this.emit('error', e); }),
      );
    }
    await Promise.all(tasks);

    this.cache = next;
    this.lastUpdated = lu;
    this.lowestBin.commit();
    this.emit('cycle', {
      lastUpdated: lu,
      detectLagMs: detectedAt - lu,
      fetchMs: Date.now() - detectedAt,
      pages,
      totalAuctions: total,
      newAuctions: newCount,
      intervalMs: this.intervalMs,
    });
  }

  private decode(a: Auction): AuctionEntry | null {
    try {
      const item = decodeItemBytes(itemBytesOf(a));
      const keys = buildKeys(item, item.rarity ?? a.tier);
      return { auction: a, item, keys, unitPrice: a.starting_bid / item.count };
    } catch {
      return null; // undecodable item: remembered as null so we do not retry every cycle
    }
  }
}
