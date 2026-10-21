import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Settings {
  /** Minimum absolute profit in coins after fees. */
  minProfit: number;
  /** Minimum profit as a fraction of purchase price (0.1 = 10%). */
  minProfitPercent: number;
  /** Skip flips costing more than this (your purse). 0 = unlimited. */
  maxPrice: number;
  /** Require at least this many comparable sales per day for MEDIAN flips. */
  minSalesPerDay: number;
  /** Which flip kinds to emit. */
  kinds: { SNIPE: boolean; MEDIAN: boolean };
  /** Allow flips whose price reference came from a coarse key tier. */
  maxKeyTier: number;
  /** Item ids never to flip. */
  blacklist: string[];
  /** If non-empty, only these item ids are considered. */
  whitelist: string[];
  /** Play a sound in the web UI. */
  sound: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  minProfit: 150_000,
  minProfitPercent: 0.05,
  maxPrice: 0,
  minSalesPerDay: 1,
  kinds: { SNIPE: true, MEDIAN: true },
  maxKeyTier: 2,
  blacklist: [],
  whitelist: [],
  sound: true,
};

export class SettingsStore {
  private readonly file: string;
  public current: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'settings.json');
    this.current = { ...DEFAULT_SETTINGS };
    if (existsSync(this.file)) {
      try {
        this.current = sanitize({ ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(this.file, 'utf8')) });
      } catch { /* keep defaults on corrupt file */ }
    } else {
      this.persist();
    }
  }

  update(patch: Partial<Settings>): Settings {
    this.current = sanitize({ ...this.current, ...patch, kinds: { ...this.current.kinds, ...(patch.kinds ?? {}) } });
    this.persist();
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  onChange(l: (s: Settings) => void): void { this.listeners.add(l); }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.current, null, 2));
  }
}

function sanitize(s: Settings): Settings {
  const n = (v: unknown, d: number, min = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d);
  const ids = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).toUpperCase().trim()).filter(Boolean) : []);
  return {
    minProfit: n(s.minProfit, DEFAULT_SETTINGS.minProfit),
    minProfitPercent: n(s.minProfitPercent, DEFAULT_SETTINGS.minProfitPercent),
    maxPrice: n(s.maxPrice, 0),
    minSalesPerDay: n(s.minSalesPerDay, DEFAULT_SETTINGS.minSalesPerDay),
    kinds: { SNIPE: s.kinds?.SNIPE !== false, MEDIAN: s.kinds?.MEDIAN !== false },
    maxKeyTier: Math.min(4, Math.floor(n(s.maxKeyTier, DEFAULT_SETTINGS.maxKeyTier))),
    blacklist: ids(s.blacklist),
    whitelist: ids(s.whitelist),
    sound: s.sound !== false,
  };
}
