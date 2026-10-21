import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';
export type FlipKind = 'SNIPE' | 'MEDIAN' | 'USER';

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
  /** Match any kind except this one (Coflnet's ALL_EXCEPT_USER). */
  kindNot?: FlipKind;
  minPrice?: number;
  maxPrice?: number;
  minProfit?: number;
  maxProfit?: number;
  minProfitPercent?: number;
  maxProfitPercent?: number;
  minSalesPerDay?: number;
  maxSalesPerDay?: number;
  /** Match only flips at this risk or riskier (for blacklists) / up to this risk (for whitelists). */
  risk?: Risk;
  // ---- item attribute conditions (all optional, all must hold) ----
  /** Case-insensitive substring of the display name. */
  nameContains?: string;
  /** Hypixel item category (PET, HOE, RUNE, FURNITURE, …), from the items resource. */
  category?: string;
  reforge?: string;
  shiny?: boolean;
  /** Dye item id, or "NONE" for undyed. */
  dye?: string;
  /** Pet skin id, or "ANY" for any skin, "NONE" for no skin. */
  petSkin?: string;
  /** Armour skin id, "ANY" or "NONE". */
  skin?: string;
  /** Leather colour hex values (any of). */
  colors?: string[];
  candyMin?: number;
  candyMax?: number;
  /** Exact set of ability scrolls (sorted, upper-case); empty array = none. */
  abilityScrolls?: string[];
  starsMin?: number;
  starsMax?: number;
  petLevelMin?: number;
  petLevelMax?: number;
  /** Held pet item id; prefix with "!" to require it NOT be held. */
  petItem?: string;
  /**
   * Whitelist only: a "user finder". When the rule matches, the listing is reported as a USER flip
   * even without a price reference, using maxPrice as the value estimate. This is how Coflnet
   * configs express "any X under Y coins is a buy".
   */
  finder?: boolean;
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
  /**
   * Auto-buy: what the modsocket bridge forwards to connected bots. `enabled` is the purchase
   * switch; off means nothing is forwarded even while a bot is logged in.
   */
  autobuy: AutobuySettings;
  /** Stealth pacing: the backend starts/stops the bot service on a randomised schedule. */
  pacing: PacingSettings;
}

export interface AutobuySettings {
  enabled: boolean;
  minProfit: number;
  /** 0.08 = 8 %. */
  minProfitPercent: number;
  /** 0 = unlimited. */
  maxPrice: number;
  maxRisk: Risk;
  /** Skip flips whose reference price came from nowhere (priceSource 'none'). */
  requireHistory: boolean;
  /** Also skip flips priced only from Coflnet's per-item median. */
  requireOwnHistory: boolean;
  autoSell: boolean;
  /** List at target × (1 − undercut), never below cost × 1.03. */
  undercutPercent: number;
  listHours: number;
  /** Never let a purchase take the purse below this (needs the bot's scoreboard upload). */
  purseReserve: number;
  /** Hypixel's grace period after a BIN is created ("bed"); purchaseAt = auction start + this. */
  bedDelayMs: number;
  /** Don't forward a flip whose auction was created more than this long ago. */
  maxAgeMs: number;
  /** Per bot. 0 = unlimited. */
  maxBuysPerHour: number;
  /** Discord webhook for buy/sell notifications (optional). */
  webhookUrl: string;
  /** Second phase: forward bazaar order flips (`bazaarFlip`) to bots that place bazaar orders (the Rust BAF does; ours ignores them). */
  bazaarOrders: boolean;
  /** Max coins per bazaar order. */
  bazaarMaxOrder: number;
}

export interface PacingSettings {
  /** Stealth session pacing: online spans and offline gaps, daily allowance. */
  enabled: boolean;
  minSessionMinutes: number;
  maxSessionMinutes: number;
  minBreakMinutes: number;
  maxBreakMinutes: number;
  /** 0 = no cap. */
  dailyOnlineMinutes: number;
  /** Humanization: short random breaks inside a session. */
  humanize: boolean;
  humanMinIntervalMinutes: number;
  humanMaxIntervalMinutes: number;
  humanMinBreakMinutes: number;
  humanMaxBreakMinutes: number;
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
  autobuy: {
    enabled: false, minProfit: 500_000, minProfitPercent: 0.08, maxPrice: 0, maxRisk: 'LOW', requireHistory: true, requireOwnHistory: false,
    autoSell: true, undercutPercent: 0.02, listHours: 48, purseReserve: 0, bedDelayMs: 20_000, maxAgeMs: 60_000, maxBuysPerHour: 0, webhookUrl: '',
    bazaarOrders: false, bazaarMaxOrder: 5_000_000,
  },
  pacing: {
    enabled: false, minSessionMinutes: 60, maxSessionMinutes: 300, minBreakMinutes: 30, maxBreakMinutes: 180, dailyOnlineMinutes: 600,
    humanize: false, humanMinIntervalMinutes: 45, humanMaxIntervalMinutes: 120, humanMinBreakMinutes: 2, humanMaxBreakMinutes: 10,
  },
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
  name: string; category?: string; reforge?: string; shiny: boolean; dye?: string; petSkin?: string; skin?: string; color?: string;
  candy: number; abilityScrolls: string[]; stars: number; petLevel?: number; petItem?: string;
}

export function itemMatches(pattern: string, item: string): boolean {
  if (pattern.endsWith('*')) return item.startsWith(pattern.slice(0, -1));
  return pattern === item;
}

/** Conditions that depend only on the item, not on pricing. Used to pre-match finder rules. */
export function itemConditionsMatch(r: Rule, s: RuleSubject): boolean {
  if (r.item && !itemMatches(r.item, s.item)) return false;
  if (r.rarity && r.rarity !== s.rarity) return false;
  if (r.minPrice !== undefined && s.price < r.minPrice) return false;
  if (r.maxPrice !== undefined && s.price > r.maxPrice) return false;
  if (r.nameContains && !s.name.toLowerCase().includes(r.nameContains.toLowerCase())) return false;
  if (r.category && r.category !== s.category) return false;
  if (r.reforge && r.reforge.toLowerCase() !== (s.reforge ?? '').toLowerCase()) return false;
  if (r.shiny !== undefined && r.shiny !== s.shiny) return false;
  if (r.dye && (r.dye === 'NONE' ? s.dye !== undefined : r.dye !== s.dye)) return false;
  if (r.petSkin && (r.petSkin === 'NONE' ? s.petSkin !== undefined : r.petSkin === 'ANY' ? s.petSkin === undefined : r.petSkin !== s.petSkin)) return false;
  if (r.skin && (r.skin === 'NONE' ? s.skin !== undefined : r.skin === 'ANY' ? s.skin === undefined : r.skin !== s.skin)) return false;
  if (r.colors && r.colors.length && (!s.color || !r.colors.some((c) => c.toUpperCase() === s.color))) return false;
  if (r.candyMin !== undefined && s.candy < r.candyMin) return false;
  if (r.candyMax !== undefined && s.candy > r.candyMax) return false;
  if (r.abilityScrolls && (r.abilityScrolls.length !== s.abilityScrolls.length || r.abilityScrolls.some((x, i) => x !== s.abilityScrolls[i]))) return false;
  if (r.starsMin !== undefined && s.stars < r.starsMin) return false;
  if (r.starsMax !== undefined && s.stars > r.starsMax) return false;
  if (r.petLevelMin !== undefined && (s.petLevel ?? 0) < r.petLevelMin) return false;
  if (r.petLevelMax !== undefined && (s.petLevel ?? 0) > r.petLevelMax) return false;
  if (r.petItem) {
    if (r.petItem.startsWith('!')) { if (s.petItem === r.petItem.slice(1)) return false; }
    else if (s.petItem !== r.petItem) return false;
  }
  return true;
}

export function ruleMatches(r: Rule, s: RuleSubject, mode: 'blacklist' | 'whitelist'): boolean {
  if (!itemConditionsMatch(r, s)) return false;
  if (r.kind && r.kind !== s.kind) return false;
  if (r.kindNot && r.kindNot === s.kind) return false;
  if (r.minProfit !== undefined && s.profit < r.minProfit) return false;
  if (r.maxProfit !== undefined && s.profit > r.maxProfit) return false;
  if (r.minProfitPercent !== undefined && s.profitPercent < r.minProfitPercent) return false;
  if (r.maxProfitPercent !== undefined && s.profitPercent > r.maxProfitPercent) return false;
  if (r.minSalesPerDay !== undefined && s.salesPerDay < r.minSalesPerDay) return false;
  if (r.maxSalesPerDay !== undefined && s.salesPerDay > r.maxSalesPerDay) return false;
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
      autobuy: { ...this.current.autobuy, ...(patch.autobuy ?? {}) },
      pacing: { ...this.current.pacing, ...(patch.pacing ?? {}) },
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
      // ---- auto-buy ----
      case 'autobuy': this.update({ autobuy: { ...this.current.autobuy, enabled: bool } as AutobuySettings }); return;
      case 'autobuyminprofit': this.update({ autobuy: { ...this.current.autobuy, minProfit: num } as AutobuySettings }); return;
      case 'autobuyminpercent': case 'autobuyminprofitpercent': this.update({ autobuy: { ...this.current.autobuy, minProfitPercent: num > 1 ? num / 100 : num } as AutobuySettings }); return;
      case 'autobuymaxprice': case 'autobuypurse': this.update({ autobuy: { ...this.current.autobuy, maxPrice: num } as AutobuySettings }); return;
      case 'autobuyreserve': case 'autobuypursereserve': this.update({ autobuy: { ...this.current.autobuy, purseReserve: num } as AutobuySettings }); return;
      case 'autobuyrisk': case 'autobuymaxrisk': {
        const r = value.toUpperCase();
        if (r !== 'LOW' && r !== 'MEDIUM' && r !== 'HIGH') return 'risk must be LOW, MEDIUM or HIGH';
        this.update({ autobuy: { ...this.current.autobuy, maxRisk: r } as AutobuySettings }); return;
      }
      case 'autosell': this.update({ autobuy: { ...this.current.autobuy, autoSell: bool } as AutobuySettings }); return;
      case 'autobuyundercut': this.update({ autobuy: { ...this.current.autobuy, undercutPercent: num > 1 ? num / 100 : num } as AutobuySettings }); return;
      case 'autobuylisthours': case 'listhours': this.update({ autobuy: { ...this.current.autobuy, listHours: num } as AutobuySettings }); return;
      case 'autobuybeddelay': this.update({ autobuy: { ...this.current.autobuy, bedDelayMs: num } as AutobuySettings }); return;
      case 'autobuyperhour': case 'autobuymaxbuysperhour': this.update({ autobuy: { ...this.current.autobuy, maxBuysPerHour: num } as AutobuySettings }); return;
      case 'webhook': case 'autobuywebhook': this.update({ autobuy: { ...this.current.autobuy, webhookUrl: /^(off|none|-)$/i.test(value) ? '' : value.trim() } as AutobuySettings }); return;
      case 'bazaarorders': case 'autobazaar': this.update({ autobuy: { ...this.current.autobuy, bazaarOrders: bool } as AutobuySettings }); return;
      case 'pacing': case 'stealth': this.update({ pacing: { ...this.current.pacing, enabled: bool } as PacingSettings }); return;
      case 'humanize': case 'humanization': this.update({ pacing: { ...this.current.pacing, humanize: bool } as PacingSettings }); return;
      default: return `unknown setting "${key}"; try minProfit, minProfitPercent, maxPrice, minVolume, maxKeyTier, maxRisk, mode, whitelistOnly, autobuy, autobuyMinProfit, autobuyMinPercent, autobuyMaxPrice, autobuyRisk, autobuyReserve, autoSell, autobuyUndercut, listHours, webhook, pacing, humanize`;
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
    const up = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim().toUpperCase() : undefined);
    if (up('item')) rule.item = up('item');
    if (up('rarity')) rule.rarity = up('rarity');
    if (r.kind === 'SNIPE' || r.kind === 'MEDIAN' || r.kind === 'USER') rule.kind = r.kind;
    if (r.kindNot === 'SNIPE' || r.kindNot === 'MEDIAN' || r.kindNot === 'USER') rule.kindNot = r.kindNot;
    for (const k of ['minPrice', 'maxPrice', 'minProfit', 'maxProfit', 'minProfitPercent', 'maxProfitPercent', 'minSalesPerDay', 'maxSalesPerDay',
      'candyMin', 'candyMax', 'starsMin', 'starsMax', 'petLevelMin', 'petLevelMax'] as const) {
      if (typeof r[k] === 'number' && Number.isFinite(r[k] as number)) rule[k] = r[k] as number;
    }
    if (r.risk === 'LOW' || r.risk === 'MEDIUM' || r.risk === 'HIGH') rule.risk = r.risk;
    if (typeof r.nameContains === 'string' && r.nameContains.trim()) rule.nameContains = r.nameContains.trim();
    if (up('category')) rule.category = up('category');
    if (typeof r.reforge === 'string' && r.reforge.trim()) rule.reforge = r.reforge.trim();
    if (typeof r.shiny === 'boolean') rule.shiny = r.shiny;
    if (up('dye')) rule.dye = up('dye');
    if (up('petSkin')) rule.petSkin = up('petSkin');
    if (up('skin')) rule.skin = up('skin');
    if (Array.isArray(r.colors)) rule.colors = (r.colors as unknown[]).map((c) => String(c).replace('#', '').toUpperCase()).filter((c) => /^[0-9A-F]{6}$/.test(c));
    if (Array.isArray(r.abilityScrolls)) rule.abilityScrolls = (r.abilityScrolls as unknown[]).map((c) => String(c).toUpperCase()).sort();
    if (typeof r.petItem === 'string' && r.petItem.trim()) rule.petItem = r.petItem.trim().toUpperCase();
    if (r.finder === true) rule.finder = true;
    if (typeof r.note === 'string') rule.note = r.note.slice(0, 160);
    if (Object.keys(rule).filter((k) => k !== 'note').length) out.push(rule);
  }
  return out;
}

export function sanitize(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & Record<string, unknown>;
  const kinds = (s.kinds ?? {}) as Partial<Settings['kinds']>;
  const bz = (s.bazaar ?? {}) as Partial<Settings['bazaar']>;
  const ab = (s.autobuy ?? {}) as Partial<AutobuySettings>;
  const pc = (s.pacing ?? {}) as Partial<PacingSettings>;
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
    autobuy: {
      enabled: ab.enabled === true,
      minProfit: n(ab.minProfit, D.autobuy.minProfit),
      minProfitPercent: n(ab.minProfitPercent, D.autobuy.minProfitPercent),
      maxPrice: n(ab.maxPrice, 0),
      maxRisk: risk(ab.maxRisk, D.autobuy.maxRisk),
      requireHistory: ab.requireHistory !== false,
      requireOwnHistory: ab.requireOwnHistory === true,
      autoSell: ab.autoSell !== false,
      undercutPercent: Math.min(0.5, n(ab.undercutPercent, D.autobuy.undercutPercent)),
      listHours: Math.max(1, Math.min(336, Math.floor(n(ab.listHours, D.autobuy.listHours, 1)))),
      purseReserve: n(ab.purseReserve, 0),
      bedDelayMs: n(ab.bedDelayMs, D.autobuy.bedDelayMs),
      maxAgeMs: n(ab.maxAgeMs, D.autobuy.maxAgeMs, 1_000),
      maxBuysPerHour: Math.floor(n(ab.maxBuysPerHour, 0)),
      webhookUrl: typeof ab.webhookUrl === 'string' && /^https:\/\//.test(ab.webhookUrl) ? ab.webhookUrl.trim() : '',
      bazaarOrders: ab.bazaarOrders === true,
      bazaarMaxOrder: n(ab.bazaarMaxOrder, D.autobuy.bazaarMaxOrder),
    },
    pacing: {
      enabled: pc.enabled === true,
      minSessionMinutes: n(pc.minSessionMinutes, D.pacing.minSessionMinutes, 1),
      maxSessionMinutes: n(pc.maxSessionMinutes, D.pacing.maxSessionMinutes, 1),
      minBreakMinutes: n(pc.minBreakMinutes, D.pacing.minBreakMinutes, 1),
      maxBreakMinutes: n(pc.maxBreakMinutes, D.pacing.maxBreakMinutes, 1),
      dailyOnlineMinutes: n(pc.dailyOnlineMinutes, D.pacing.dailyOnlineMinutes),
      humanize: pc.humanize === true,
      humanMinIntervalMinutes: n(pc.humanMinIntervalMinutes, D.pacing.humanMinIntervalMinutes, 1),
      humanMaxIntervalMinutes: n(pc.humanMaxIntervalMinutes, D.pacing.humanMaxIntervalMinutes, 1),
      humanMinBreakMinutes: n(pc.humanMinBreakMinutes, D.pacing.humanMinBreakMinutes, 1),
      humanMaxBreakMinutes: n(pc.humanMaxBreakMinutes, D.pacing.humanMaxBreakMinutes, 1),
    },
  };
}
