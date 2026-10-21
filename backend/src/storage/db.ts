import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Flip } from '../flips/detector.js';
import type { Purchase } from '../flips/tracker.js';

/**
 * Durable store for sales history (so medians survive restarts) and emitted flips
 * (so you can audit what the detector said versus what actually sold).
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly insSale;
  private readonly insFlip;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'skyflip.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sales (
        auction_id TEXT PRIMARY KEY,
        item_id    TEXT NOT NULL,
        keys       TEXT NOT NULL,
        unit_price INTEGER NOT NULL,
        count      INTEGER NOT NULL,
        bin        INTEGER NOT NULL,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sales_ts ON sales(ts);
      CREATE TABLE IF NOT EXISTS players (uuid TEXT PRIMARY KEY, added INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS purchases (
        auction_id   TEXT PRIMARY KEY,
        player       TEXT NOT NULL,
        item_id      TEXT NOT NULL,
        item_name    TEXT NOT NULL,
        item_uuid    TEXT,
        price        INTEGER NOT NULL,
        bought_at    INTEGER NOT NULL,
        predicted    INTEGER,
        sold_at      INTEGER,
        sold_price   INTEGER,
        sold_auction TEXT
      );
      CREATE INDEX IF NOT EXISTS purchases_player ON purchases(player, bought_at);
      CREATE INDEX IF NOT EXISTS purchases_item ON purchases(player, item_uuid);
      CREATE TABLE IF NOT EXISTS flips (
        uuid        TEXT PRIMARY KEY,
        ts          INTEGER NOT NULL,
        item_id     TEXT NOT NULL,
        price       INTEGER NOT NULL,
        target      INTEGER NOT NULL,
        profit      INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        json        TEXT NOT NULL
      );
    `);
    this.insSale = this.db.prepare(
      'INSERT OR IGNORE INTO sales (auction_id, item_id, keys, unit_price, count, bin, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.insFlip = this.db.prepare(
      'INSERT OR REPLACE INTO flips (uuid, ts, item_id, price, target, profit, kind, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
  }

  saveSales(rows: { auctionId: string; itemId: string; keys: string[]; unitPrice: number; count: number; bin: boolean; ts: number }[]): void {
    if (rows.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.insSale.run(r.auctionId, r.itemId, JSON.stringify(r.keys), r.unitPrice, r.count, r.bin ? 1 : 0, r.ts);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Stream sales newer than `since` in time order. */
  loadSales(since: number): { keys: string[]; unitPrice: number; bin: boolean; ts: number }[] {
    const rows = this.db.prepare('SELECT keys, unit_price, bin, ts FROM sales WHERE ts >= ? ORDER BY ts ASC').all(since) as
      { keys: string; unit_price: number; bin: number; ts: number }[];
    return rows.map((r) => ({ keys: JSON.parse(r.keys) as string[], unitPrice: r.unit_price, bin: r.bin === 1, ts: r.ts }));
  }

  savePlayer(uuid: string): void {
    this.db.prepare('INSERT OR IGNORE INTO players (uuid, added) VALUES (?, ?)').run(uuid, Date.now());
  }
  loadPlayers(): string[] {
    return (this.db.prepare('SELECT uuid FROM players').all() as { uuid: string }[]).map((r) => r.uuid);
  }

  savePurchase(p: Purchase): void {
    this.db.prepare(`INSERT OR REPLACE INTO purchases (auction_id, player, item_id, item_name, item_uuid, price, bought_at, predicted, sold_at, sold_price, sold_auction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      p.auctionId, p.player, p.itemId, p.itemName, p.itemUuid ?? null, p.price, p.boughtAt, p.predictedProfit ?? null, p.soldAt ?? null, p.soldPrice ?? null, p.soldAuctionId ?? null);
  }
  findOpenPurchase(player: string, itemUuid: string): Purchase | undefined {
    const r = this.db.prepare('SELECT * FROM purchases WHERE player = ? AND item_uuid = ? AND sold_at IS NULL ORDER BY bought_at DESC LIMIT 1').get(player, itemUuid) as unknown as PurchaseRow | undefined;
    return r ? rowToPurchase(r) : undefined;
  }
  purchasesSince(player: string, since: number): Purchase[] {
    const rows = this.db.prepare('SELECT * FROM purchases WHERE player = ? AND bought_at >= ? ORDER BY bought_at ASC').all(player, since) as unknown as PurchaseRow[];
    return rows.map(rowToPurchase);
  }

  saveFlip(f: Flip): void {
    this.insFlip.run(f.uuid, f.detectedAt, f.itemId, f.price, f.target, f.profit, f.kind, JSON.stringify(f));
  }

  loadFlip(uuid: string): Flip | undefined {
    const r = this.db.prepare('SELECT json FROM flips WHERE uuid = ?').get(uuid) as { json: string } | undefined;
    if (!r) return undefined;
    try { return JSON.parse(r.json) as Flip; } catch { return undefined; }
  }
  /** Unsold purchases of a player, oldest first. */
  openPurchases(player: string, since: number): Purchase[] {
    const rows = this.db.prepare('SELECT * FROM purchases WHERE player = ? AND bought_at >= ? AND sold_at IS NULL ORDER BY bought_at ASC').all(player, since) as unknown as PurchaseRow[];
    return rows.map(rowToPurchase);
  }

  pruneSales(olderThan: number): number {
    const r = this.db.prepare('DELETE FROM sales WHERE ts < ?').run(olderThan);
    return Number(r.changes);
  }

  salesCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number };
    return r.n;
  }

  close(): void { this.db.close(); }
}

interface PurchaseRow {
  auction_id: string; player: string; item_id: string; item_name: string; item_uuid: string | null; price: number; bought_at: number;
  predicted: number | null; sold_at: number | null; sold_price: number | null; sold_auction: string | null;
}
function rowToPurchase(r: PurchaseRow): Purchase {
  return {
    auctionId: r.auction_id, player: r.player, itemId: r.item_id, itemName: r.item_name, itemUuid: r.item_uuid ?? undefined, price: r.price,
    boughtAt: r.bought_at, predictedProfit: r.predicted ?? undefined, soldAt: r.sold_at ?? undefined, soldPrice: r.sold_price ?? undefined,
    soldAuctionId: r.sold_auction ?? undefined,
  };
}
