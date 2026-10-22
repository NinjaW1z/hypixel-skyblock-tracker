import { EventEmitter } from 'node:events';
import { log, sleep } from '../util/log.js';
import type { HypixelClient } from '../hypixel/client.js';
import { itemBytesOf } from '../hypixel/types.js';
import { decodeItemBytes } from '../nbt/decode.js';
import { buildKeys } from '../pricing/key.js';
import type { SalesBook } from '../pricing/priceBook.js';
import type { Store } from '../storage/db.js';
import type { SaleEvent } from '../flips/tracker.js';

/**
 * Pulls /skyblock/auctions_ended once per API refresh and folds every sale into the
 * SalesBook (memory) and Store (disk). This is the data the MEDIAN flips rely on.
 */
export class EndedPoller extends EventEmitter {
  private lastUpdated = 0;
  private running = false;
  public recorded = 0;

  constructor(private readonly client: HypixelClient, private readonly sales: SalesBook, private readonly store: Store) {
    super();
  }

  stop(): void { this.running = false; }

  /** Call right after an auctions cycle completes; the ended feed refreshes on the same clock. */
  async pollOnce(): Promise<number> {
    const res = await this.client.ended();
    if (res.lastUpdated <= this.lastUpdated) return 0;
    this.lastUpdated = res.lastUpdated;
    const rows = [];
    const events: SaleEvent[] = [];
    for (const e of res.auctions) {
      try {
        const item = decodeItemBytes(itemBytesOf(e));
        const keys = buildKeys(item, item.rarity ?? 'UNKNOWN');
        const unit = e.price / item.count;
        this.sales.record(keys, unit, e.timestamp, e.bin);
        rows.push({ auctionId: e.auction_id, itemId: item.id, keys, unitPrice: unit, count: item.count, bin: e.bin, ts: e.timestamp });
        events.push({ auctionId: e.auction_id, seller: e.seller, buyer: e.buyer, price: e.price, ts: e.timestamp, bin: e.bin, item });
      } catch { /* skip undecodable */ }
    }
    this.store.saveSales(rows);
    this.recorded += rows.length;
    this.emit('sales', rows.length, res.lastUpdated);
    for (const ev of events) this.emit('sale', ev);
    return rows.length;
  }

  /** Independent loop for when the auction poller is not driving it. */
  async run(intervalMs = 20_000): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (e) {
        log.warn('ended poll failed', (e as Error).message);
      }
      await sleep(intervalMs);
    }
  }
}
