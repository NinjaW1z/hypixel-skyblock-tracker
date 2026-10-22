import type { Settings, Rule, FlipKind } from './settings.js';

/**
 * Converts a Coflnet flip-settings export (the JSON behind `/cofl` settings, as shared in
 * community configs such as "Godflipper") into our Settings + Rule format.
 *
 * Verified against a real export (Godflipper 7.4.0): top-level `minProfit`, `minProfitPercent`
 * (percent), `minVolume` (sales/day), `maxCost`, `onlyBin`, `lbin`, `finders` (bit mask),
 * `visibility`/`mod` (client display), and `whitelist`/`blacklist` arrays of
 * `{ tag?, displayName?, filter: {Name: "value"}, tags?: string[], disabled }`.
 * Filter values use Coflnet's range syntax: "<500m", ">5m", "1-10", "200", "1.1b".
 */
export interface ImportReport {
  settingsPatch: Partial<Settings>;
  blacklist: Rule[];
  whitelist: Rule[];
  imported: number;
  skipped: { entry: string; reason: string }[];
  /** Filter names seen that we could not map, with counts, so the user knows what was lost. */
  unsupported: Record<string, number>;
  notes: string[];
}

type Filter = Record<string, string>;
interface Entry { tag?: string; displayName?: string; filter?: Filter; tags?: string[] | null; disabled?: boolean }

const UNIT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** "<500m" → {max: 5e8}; ">5m" → {min: 5e6}; "1-10" → {min:1,max:10}; "200" → {min:200,max:200}. */
export function parseRange(v: string): { min?: number; max?: number } | undefined {
  const t = v.trim().toLowerCase().replace(/,/g, '');
  const num = (x: string): number | undefined => {
    const m = /^(-?\d+(?:\.\d+)?)([kmb])?$/.exec(x.trim());
    if (!m) return undefined;
    return Number(m[1]) * (m[2] ? UNIT[m[2]] : 1);
  };
  if (t.startsWith('<')) { const n = num(t.slice(1)); return n === undefined ? undefined : { max: n }; }
  if (t.startsWith('>')) { const n = num(t.slice(1)); return n === undefined ? undefined : { min: n }; }
  const dash = t.indexOf('-', 1);
  if (dash > 0) {
    const a = num(t.slice(0, dash)), b = num(t.slice(dash + 1));
    return a === undefined || b === undefined ? undefined : { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const n = num(t);
  return n === undefined ? undefined : { min: n, max: n };
}

/** Coflnet item tag → our rule item id. */
export function mapTag(tag: string): string {
  const t = tag.trim().toUpperCase();
  const book = /^ENCHANTMENT_(.+)_(\d+)$/.exec(t);
  if (book) return `BOOK_${book[1].toLowerCase()}_${book[2]}`;
  return t;
}

function mapFinder(v: string): FlipKind | undefined {
  const f = v.toUpperCase();
  if (f === 'SNIPER') return 'SNIPE';
  if (f === 'SNIPER_MEDIAN' || f === 'FLIPPER' || f === 'AI' || f === 'MEDIAN') return 'MEDIAN';
  if (f === 'USER') return 'USER';
  return undefined; // ALL_EXCEPT_USER, CraftCost, STONKS, TFM, FLIPPER_AND_SNIPERS …: no single kind
}

const IGNORED_SILENTLY = new Set(['ForceBlacklist', 'DoNotRelist', 'ForTag', 'AfterMainFilter']);

/** Translate one entry's filter dictionary. Returns the rule plus names of filters we dropped. */
export function mapFilter(filter: Filter, list: 'blacklist' | 'whitelist'): { rule: Rule; dropped: string[]; supported: number } {
  const rule: Rule = {};
  const dropped: string[] = [];
  let supported = 0;
  for (const [rawKey, rawVal] of Object.entries(filter)) {
    const key = rawKey.trim();
    const val = String(rawVal).trim();
    if (IGNORED_SILENTLY.has(key)) continue;
    const range = () => parseRange(val);
    let ok = true;
    switch (key) {
      case 'FlipFinder': {
        const k = mapFinder(val);
        const f = val.toUpperCase();
        if (k) rule.kind = k;
        else if (f === 'ALL_EXCEPT_USER' || f === 'FLIPPER_AND_SNIPERS') rule.kindNot = 'USER';
        else ok = false;
        break;
      }
      case 'Profit': { const r = range(); if (!r) { ok = false; break; } if (r.min !== undefined) rule.minProfit = r.min; if (r.max !== undefined) rule.maxProfit = r.max; break; }
      case 'ProfitPercentage': { const r = range(); if (!r) { ok = false; break; } if (r.min !== undefined) rule.minProfitPercent = r.min / 100; if (r.max !== undefined) rule.maxProfitPercent = r.max / 100; break; }
      case 'Volume': { const r = range(); if (!r) { ok = false; break; } if (r.min !== undefined) rule.minSalesPerDay = r.min; if (r.max !== undefined) rule.maxSalesPerDay = r.max; break; }
      case 'StartingBid': case 'PriceRange': case 'MaxCost': {
        const r = key === 'MaxCost' ? { max: parseRange(val)?.max ?? parseRange(val)?.min } : range();
        if (!r) { ok = false; break; }
        if (r.min !== undefined) rule.minPrice = r.min; if (r.max !== undefined) rule.maxPrice = r.max; break;
      }
      case 'Rarity': rule.rarity = val.toUpperCase(); break;
      case 'ItemNameContains': rule.nameContains = val; break;
      case 'ItemCategory': rule.category = val.toUpperCase(); break;
      case 'ArmorSet': rule.item = rule.item ?? `${val.toUpperCase()}_*`; break;
      case 'ArmorSetNoHelmet': rule.item = rule.item ?? `${val.toUpperCase()}_*`; rule.note = appendNote(rule.note, 'set without helmet'); break;
      case 'PetSkin': rule.petSkin = val.toUpperCase() === 'ANY' ? 'ANY' : val.toUpperCase() === 'NONE' ? 'NONE' : val.toUpperCase(); break;
      case 'Skin': case 'DragonArmorSkin': case 'ReaperMaskSkin': rule.skin = val.toUpperCase(); break;
      case 'DyeItem': rule.dye = val.toUpperCase() === 'NONE' ? 'NONE' : val.toUpperCase(); break;
      case 'Color': rule.colors = [...(rule.colors ?? []), val.replace('#', '').toUpperCase()]; break;
      case 'CrystalColor': case 'FairyColor': {
        const list = val.includes(':') ? val.slice(val.indexOf(':') + 1) : val;
        rule.colors = [...(rule.colors ?? []), ...list.split(',').map((c) => c.trim().replace('#', '').toUpperCase()).filter((c) => /^[0-9A-F]{6}$/.test(c))];
        break;
      }
      case 'Candy': { const r = range(); if (!r) { ok = false; break; } if (r.min !== undefined) rule.candyMin = r.min; if (r.max !== undefined) rule.candyMax = r.max; break; }
      case 'AbilityScroll': rule.abilityScrolls = val.toUpperCase() === 'NONE' ? [] : val.toUpperCase().split(/[\s,]+/).filter(Boolean).sort(); break;
      case 'Stars': { const r = range(); if (!r) { ok = false; break; } if (r.min !== undefined) rule.starsMin = r.min; if (r.max !== undefined) rule.starsMax = r.max; break; }
      case 'PetLevel': { const r = range(); if (!r) { ok = false; break; } if (r.min !== undefined) rule.petLevelMin = r.min; if (r.max !== undefined) rule.petLevelMax = r.max; break; }
      case 'Reforge': case 'LegacyReforge': if (key === 'Reforge') rule.reforge = val; else ok = false; break;
      case 'IsShiny': rule.shiny = /^(yes|true|1)$/i.test(val); break;
      case 'PetItem': rule.petItem = val.toUpperCase().startsWith('NOT_') ? `!PET_ITEM_${val.toUpperCase().slice(4)}` : val.toUpperCase().startsWith('PET_ITEM_') ? val.toUpperCase() : `PET_ITEM_${val.toUpperCase()}`; break;
      default: ok = false;
    }
    if (ok) supported++; else dropped.push(key);
  }
  // Whitelist entries with a price cap are Coflnet "user finders": a buy whenever the item lists under the cap.
  if (list === 'whitelist' && rule.maxPrice !== undefined && rule.kind === undefined && rule.minProfit === undefined && rule.minProfitPercent === undefined) rule.finder = true;
  return { rule, dropped, supported };
}

function appendNote(note: string | undefined, add: string): string {
  return note ? `${note}; ${add}` : add;
}

export function parseCoflnetExport(json: unknown): ImportReport {
  const report: ImportReport = { settingsPatch: {}, blacklist: [], whitelist: [], imported: 0, skipped: [], unsupported: {}, notes: [] };
  const d = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (!d.whitelist && !d.blacklist && d.minProfit === undefined) {
    report.notes.push('This does not look like a Coflnet settings export (no whitelist, blacklist or minProfit).');
    return report;
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? parseRange(v)?.min : undefined);
  const sp = report.settingsPatch;
  if (num(d.minProfit) !== undefined) sp.minProfit = num(d.minProfit);
  if (num(d.minProfitPercent) !== undefined) sp.minProfitPercent = num(d.minProfitPercent)! / 100;
  if (num(d.minVolume) !== undefined) sp.minSalesPerDay = num(d.minVolume);
  if (num(d.maxCost) !== undefined) sp.maxPrice = num(d.maxCost)! >= 1e10 ? 0 : num(d.maxCost);
  if (typeof d.finders === 'string') {
    const f = d.finders.toUpperCase();
    sp.kinds = { SNIPE: f.includes('SNIPER'), MEDIAN: f.includes('FLIPPER') || f.includes('MEDIAN') || f.includes('AI') };
    if (!sp.kinds.SNIPE && !sp.kinds.MEDIAN) delete sp.kinds;
  }
  if (d.visibility || d.mod || d.modSettings) report.notes.push('Display/mod settings (visibility, sounds, formatting) are client-side here and were not imported; set them in the mod GUI.');
  if (d.onlyBin === false) report.notes.push('onlyBin=false: we only ever flag BIN listings.');

  for (const list of ['blacklist', 'whitelist'] as const) {
    const entries = Array.isArray(d[list]) ? (d[list] as Entry[]) : [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') { report.skipped.push({ entry: String(e), reason: 'not an object' }); continue; }
      const label = e.displayName || e.tag || (e.tags && e.tags.length ? e.tags.join(',') : '') || JSON.stringify(e.filter ?? {}).slice(0, 60);
      if (e.disabled) { report.skipped.push({ entry: label, reason: 'disabled in the export' }); continue; }
      const { rule, dropped, supported } = mapFilter(e.filter ?? {}, list);
      if (e.tag) rule.item = mapTag(e.tag);
      for (const k of dropped) report.unsupported[k] = (report.unsupported[k] ?? 0) + 1;
      const hasCondition = Object.keys(rule).some((k) => k !== 'note' && k !== 'finder');
      if (!hasCondition) { report.skipped.push({ entry: label, reason: `only unsupported filters: ${dropped.join(', ')}` }); continue; }
      // A rule that lost conditions is broader than intended. Broader blacklists over-block; broader whitelists over-buy. Keep both but say so.
      if (dropped.length) rule.note = appendNote(rule.note, `coflnet filters dropped: ${dropped.join(', ')}`);
      if (e.tags && e.tags.length) rule.note = appendNote(rule.note, e.tags.join(', '));
      if (e.displayName && !rule.note) rule.note = e.displayName;
      // Pet-skin finders without a tag need at least the category to avoid matching everything.
      if (!rule.item && rule.petSkin && !rule.category) rule.category = 'PET';
      report[list].push(rule);
      report.imported++;
    }
  }
  if (Object.keys(report.unsupported).length) {
    report.notes.push(`Filters with no equivalent here were dropped from ${Object.values(report.unsupported).reduce((a, b) => a + b, 0)} entries (the entries were kept, broader than intended): ${Object.keys(report.unsupported).join(', ')}.`);
  }
  return report;
}

/** Apply a report to the settings store. `replace` swaps both lists; `merge` appends and de-duplicates. */
export function applyImport(report: ImportReport, current: Settings, mode: 'merge' | 'replace'): Partial<Settings> {
  const dedupe = (rules: Rule[]) => { const seen = new Set<string>(); return rules.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; }); };
  return {
    ...report.settingsPatch,
    blacklist: mode === 'replace' ? report.blacklist : dedupe([...current.blacklist, ...report.blacklist]),
    whitelist: mode === 'replace' ? report.whitelist : dedupe([...current.whitelist, ...report.whitelist]),
  };
}
