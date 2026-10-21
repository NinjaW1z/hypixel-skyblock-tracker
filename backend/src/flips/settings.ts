import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';
export type FlipKind = 'SNIPE' | 'MEDIAN';

/**
 * A filter rule in the spirit of Coflnet's blacklist/whitelist entries.
 * Every condition is optional; a rule matches when all present conditions hold.
 * `item` may be an exact item id or a prefix with a trailing `*` (e.g. `PET_*`, `CRIMSON_*`).
 * For pets, the matched id is `PET_<TYPE>` (e.g. PET_ENDER_DRAGON); for books `BOOK_<enchant>_<lvl>`.
 */
export interface Rule {
  item?: string;
  rarity?: string;
  kind?: FlipKind;
  minPrice?: number;
  maxPrice?: number;
  minProfit?: number;
  minProfitPercent?: number;
  minSalesPerDay?: number;
  /** Match only flips at this risk or riskier (for blacklists) / up to this risk (for whitelists). */
  risk?: Risk;
  /** Free-form label shown in the UI. */
  note?: string;
}

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
  /** Hide flips riskier than this. */
  maxRisk: Risk;
  /** Rules that drop a flip when matched. */
  blacklist: Rule[];
  /**
   * Rules that force a flip through when matched. A whitelisted flip ignores minProfit,
   * minProfitPercent, minSalesPerDay, maxKeyTier and maxRisk, but still respects maxPrice
   * and the rule's own conditions. If `whitelistOnly` is set, only whitelisted flips are shown.
   */
  whitelist: Rule[];
  whitelistOnly: boolean;
  /** Play a sound in the web UI. */
  sound: boolean;
  /** Bazaar flip view defaults. */
  bazaar: { minProfitPerHour: number; minProfitPercent: number; maxPrice: number; minVolumeWeek: number; maxRisk: Risk };
}

export const DEFAULT_SETTINGS: Settings = {
  minProfit: 150_000,
  minProfitPercent: 0.05,
  maxPrice: 0,
  minSalesPerDay: 1,
  kinds: { SNIPE: true, MEDIAN: true },
  maxKeyTier: 2,
  maxRisk: 'HIGH',
  blacklist: [],
  whitelist: [],
  whitelistOnly: false,
  sound: true,
  bazaar: { minProfitPerHour: 200_000, minProfitPercent: 0.02, maxPrice: 0, minVolumeWeek: 5_000, maxRisk: 'MEDIUM' },
};

const RISK_RANK: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const riskRank = (r: Risk): number => RISK_RANK[r];

/** Item id used for rule matching: pets and books get a descriptive id. */
export function ruleItemId(itemId: string, petType?: string, bookKey?: string): string {
  if (itemId === 'PET' && petType) return `PET_${petType}`;
  if (itemId === 'ENCHANTED_BOOK' && bookKey) return bookKey;
  return itemId;
}

export interface RuleSubject {
  item: string; rarity: string; kind: FlipKind; price: number; profit: number; profitPercent: number; salesPerDay: number; risk: Risk;
}

export function itemMatches(pattern: string, item: string): boolean {
  if (pattern.endsWith('*')) return item.startsWith(pattern.slice(0, -1));
  return pattern === item;
}

export function ruleMatches(r: Rule, s: RuleSubject, mode: 'blacklist' | 'whitelist'): boolean {
  if (r.item && !itemMatches(r.item, s.item)) return false;
  if (r.rarity && r.rarity !== s.rarity) return false;
  if (r.kind && r.kind !== s.kind) return false;
  if (r.minPrice !== undefined && s.price < r.minPrice) return false;
  if (r.maxPrice !== undefined && s.price > r.maxPrice) return false;
  if (r.minProfit !== undefined && s.profit < r.minProfit) return false;
  if (r.minProfitPercent !== undefined && s.profitPercent < r.minProfitPercent) return false;
  if (r.minSalesPerDay !== undefined && s.salesPerDay < r.minSalesPerDay) return false;
  if (r.risk) {
    // Blacklist "risk: MEDIUM" means "drop MEDIUM and HIGH"; whitelist "risk: MEDIUM" means "allow up to MEDIUM".
    if (mode === 'blacklist' && riskRank(s.risk) < riskRank(r.risk)) return false;
    if (mode === 'whitelist' && riskRank(s.risk) > riskRank(r.risk)) return false;
  }
  return true;
}

export class SettingsStore {
  private readonly file: string;
  public current: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'settings.json');
    this.current = structuredClone(DEFAULT_SETTINGS);
    if (existsSync(this.file)) {
      try {
        this.current = sanitize(JSON.parse(readFileSync(this.file, 'utf8')));
      } catch { /* keep defaults on corrupt file */ }
    } else {
      this.persist();
    }
  }

  /** Shallow patch with nested merge for `kinds` and `bazaar`; lists replace wholesale. */
  update(patch: Partial<Settings>): Settings {
    const merged = {
      ...this.current,
      ...patch,
      kinds: { ...this.current.kinds, ...(patch.kinds ?? {}) },
      bazaar: { ...this.current.bazaar, ...(patch.bazaar ?? {}) },
    };
    this.current = sanitize(merged);
    this.persist();
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  /** Convenience for the mod's `/skyflip blacklist add` style commands. */
  addRule(list: 'blacklist' | 'whitelist', rule: Rule): Settings {
    const rules = [...this.current[list].filter((r) => JSON.stringify(r) !== JSON.stringify(rule)), rule];
    return this.update({ [list]: rules } as Partial<Settings>);
  }
  removeRule(list: 'blacklist' | 'whitelist', item: string): Settings {
    return this.update({ [list]: this.current[list].filter((r) => r.item !== item) } as Partial<Settings>);
  }

  /** Generic `set key value` used by chat commands. Returns an error string when the key is unknown. */
  set(key: string, value: string): string | undefined {
    const num = Number(value.replace(/[,_]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000').replace(/b$/i, '000000000'));
    const bool = /^(true|on|yes|1)$/i.test(value);
    switch (key.toLowerCase()) {
      case 'minprofit': this.update({ minProfit: num }); return;
      case 'minprofitpercent': case 'minpercent': this.update({ minProfitPercent: num > 1 ? num / 100 : num }); return;
      case 'maxprice': case 'purse': case 'maxcost': this.update({ maxPrice: num }); return;
      case 'minvolume': case 'minsalesperday': this.update({ minSalesPerDay: num }); return;
      case 'maxkeytier': case 'tier': this.update({ maxKeyTier: num }); return;
      case 'maxrisk': case 'risk': {
        const r = value.toUpperCase();
        if (r !== 'LOW' && r !== 'MEDIUM' && r !== 'HIGH') return 'risk must be LOW, MEDIUM or HIGH';
        this.update({ maxRisk: r }); return;
      }
      case 'mode': {
        const m = value.toLowerCase();
        if (m === 'sniper' || m === 'snipe') this.update({ kinds: { SNIPE: true, MEDIAN: false } });
        else if (m === 'median') this.update({ kinds: { SNIPE: false, MEDIAN: true } });
        else if (m === 'all' || m === 'both') this.update({ kinds: { SNIPE: true, MEDIAN: true } });
        else return 'mode must be sniper, median or all';
        return;
      }
      case 'whitelistonly': this.update({ whitelistOnly: bool }); return;
      case 'sound': this.update({ sound: bool }); return;
      default: return `unknown setting "${key}"; try minProfit, minProfitPercent, maxPrice, minVolume, maxKeyTier, maxRisk, mode, whitelistOnly`;
    }
  }

  onChange(l: (s: Settings) => void): void { this.listeners.add(l); }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.current, null, 2));
  }
}

function n(v: unknown, d: number, min = 0): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d;
}
function risk(v: unknown, d: Risk): Risk {
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' ? v : d;
}
function rules(v: unknown): Rule[] {
  if (!Array.isArray(v)) return [];
  const out: Rule[] = [];
  for (const raw of v) {
    // Back-compat: plain strings are item ids.
    const r: Record<string, unknown> = typeof raw === 'string' ? { item: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const rule: Rule = {};
    if (typeof r.item === 'string' && r.item.trim()) rule.item = r.item.trim().toUpperCase();
    if (typeof r.rarity === 'string' && r.rarity.trim()) rule.rarity = r.rarity.trim().toUpperCase();
    if (r.kind === 'SNIPE' || r.kind === 'MEDIAN') rule.kind = r.kind;
    for (const k of ['minPrice', 'maxPrice', 'minProfit', 'minProfitPercent', 'minSalesPerDay'] as const) {
      if (typeof r[k] === 'number' && Number.isFinite(r[k] as number)) rule[k] = r[k] as number;
    }
    if (r.risk === 'LOW' || r.risk === 'MEDIUM' || r.risk === 'HIGH') rule.risk = r.risk;
    if (typeof r.note === 'string') rule.note = r.note.slice(0, 120);
    if (Object.keys(rule).filter((k) => k !== 'note').length) out.push(rule);
  }
  return out;
}

export function sanitize(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & Record<string, unknown>;
  const kinds = (s.kinds ?? {}) as Partial<Settings['kinds']>;
  const bz = (s.bazaar ?? {}) as Partial<Settings['bazaar']>;
  const D = DEFAULT_SETTINGS;
  return {
    minProfit: n(s.minProfit, D.minProfit),
    minProfitPercent: n(s.minProfitPercent, D.minProfitPercent),
    maxPrice: n(s.maxPrice, 0),
    minSalesPerDay: n(s.minSalesPerDay, D.minSalesPerDay),
    kinds: { SNIPE: kinds.SNIPE !== false, MEDIAN: kinds.MEDIAN !== false },
    maxKeyTier: Math.min(4, Math.floor(n(s.maxKeyTier, D.maxKeyTier))),
    maxRisk: risk(s.maxRisk, D.maxRisk),
    blacklist: rules(s.blacklist),
    whitelist: rules(s.whitelist),
    whitelistOnly: s.whitelistOnly === true,
    sound: s.sound !== false,
    bazaar: {
      minProfitPerHour: n(bz.minProfitPerHour, D.bazaar.minProfitPerHour),
      minProfitPercent: n(bz.minProfitPercent, D.bazaar.minProfitPercent),
      maxPrice: n(bz.maxPrice, 0),
      minVolumeWeek: n(bz.minVolumeWeek, D.bazaar.minVolumeWeek),
      maxRisk: risk(bz.maxRisk, D.bazaar.maxRisk),
    },
  };
}
