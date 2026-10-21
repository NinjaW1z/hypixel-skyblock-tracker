import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Flip } from '../flips/detector.js';

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

  saveFlip(f: Flip): void {
    this.insFlip.run(f.uuid, f.detectedAt, f.itemId, f.price, f.target, f.profit, f.kind, JSON.stringify(f));
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
