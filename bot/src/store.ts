import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Purchase, BotStats } from './types.js';

interface StateFile { purchases: Purchase[]; stats: BotStats; version: 1 }

/** JSON state on disk: purchases and running totals. Small, so written whole, atomically. */
export class Store {
  readonly path: string;
  purchases: Purchase[] = [];
  stats: BotStats;
  private timer?: NodeJS.Timeout;

  constructor(dataDir: string, now = Date.now()) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'bot-state.json');
    this.stats = { startedAt: now, bought: 0, spent: 0, listed: 0, sold: 0, revenue: 0, failed: 0, skipped: 0 };
    if (existsSync(this.path)) {
      try {
        const f = JSON.parse(readFileSync(this.path, 'utf8')) as StateFile;
        this.purchases = f.purchases ?? [];
        this.stats = { ...this.stats, ...(f.stats ?? {}), startedAt: now };
      } catch { /* start fresh */ }
    }
  }

  get open(): Purchase[] { return this.purchases.filter((p) => p.state !== 'sold' && p.state !== 'lost'); }
  find(auctionId: string): Purchase | undefined { return this.purchases.find((p) => p.auctionId === auctionId); }

  add(p: Purchase): void {
    this.purchases.push(p);
    if (this.purchases.length > 2000) this.purchases.splice(0, this.purchases.length - 2000);
    this.save();
  }

  /** Debounced write. */
  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 300);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const tmp = this.path + '.tmp';
    const body: StateFile = { version: 1, purchases: this.purchases, stats: this.stats };
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, this.path);
  }
}
