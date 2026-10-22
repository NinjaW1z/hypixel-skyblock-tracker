import { gunzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';

/**
 * Everything about an auctioned item that influences its price.
 * Extracted from the ExtraAttributes NBT compound Hypixel attaches to every item.
 */
export interface ItemData {
  /** SkyBlock item id, e.g. HYPERION, PET, ENCHANTED_BOOK. */
  id: string;
  /** Stack size. Prices are compared per unit. */
  count: number;
  /** Display name with color codes stripped. */
  name: string;
  /** Lore lines with colour codes, as shown in game. */
  lore: string[];
  /** Leather/armour dye colour as 6-digit hex (e.g. "FF00AA"), when the item carries one. */
  color?: string;
  reforge?: string;
  enchants: Record<string, number>;
  hotPotato: number;
  recombobulated: boolean;
  /** Dungeon/master stars: 0..10. */
  stars: number;
  gems: string[];           // e.g. ["JASPER:PERFECT", "RUBY:FLAWLESS"]
  attributes: Record<string, number>;
  pet?: {
    type: string;
    tier: string;
    level: number;
    heldItem?: string;
    skin?: string;
    candyUsed: number;
  };
  skin?: string;
  shiny: boolean;
  artOfWar: number;
  artOfPeace: boolean;
  ethermerge: boolean;
  tunedTransmission: number;
  powerScroll?: string;
  abilityScrolls: string[];
  drillParts: string[];
  runes: Record<string, number>;
  enrichment?: string;
  woodSingularity: boolean;
  farmingForDummies: number;
  dye?: string;
  statsBook: boolean;
  winningBid?: number;      // Midas Sword / Staff
  cakeYear?: number;        // New Year Cake
  edition?: number;
  partyHatColor?: string;
  partyHatEmoji?: string;
  bossTier?: number;        // Kuudra keys
  manaDisintegrator: number;
  jalapeno: number;
  polarvoid: number;
  divanPowderCoating: boolean;
  thunderCharge: number;
  /** Rarity parsed from the lore's last line (consistent across active and ended feeds). */
  rarity?: string;
  /** Raw ExtraAttributes for anything the key builder does not model. */
  raw: Record<string, unknown>;
}

const COLOR_RE = /§[0-9a-fk-or]/gi;
const RARITIES = ['VERY_SPECIAL', 'SPECIAL', 'DIVINE', 'MYTHIC', 'LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON', 'ADMIN', 'ULTIMATE'];

/** The last lore line names the rarity, e.g. "§6§lLEGENDARY DUNGEON HELMET" or "§l§6LEGENDARY". */
export function rarityFromLore(lore: string[]): string | undefined {
  for (let i = lore.length - 1; i >= Math.max(0, lore.length - 3); i--) {
    const line = stripColor(lore[i]).trim().toUpperCase().replace(/^A |^AN /, '').replace(/ /g, '_');
    for (const r of RARITIES) if (line === r || line.startsWith(r + '_') || line.startsWith(r + ' ')) return r;
  }
  return undefined;
}
export function stripColor(s: string): string {
  return s.replace(COLOR_RE, '');
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
    // prismarine-nbt long as [hi, lo]
    return v[0] * 2 ** 32 + (v[1] >>> 0);
  }
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(asRecord(v))) out[k] = asNumber(val);
  return out;
}

/** Decode the base64+gzip NBT blob of one auction into an ItemData. */
export function decodeItemBytes(b64: string): ItemData {
  const raw = gunzipSync(Buffer.from(b64, 'base64'));
  const parsed = nbt.parseUncompressed(raw, 'big');
  const root = nbt.simplify(parsed) as { i?: unknown[] };
  const item = asRecord(root.i?.[0]);
  return itemFromSimplified(item);
}

/** Build ItemData from an already simplified NBT item compound (exposed for tests and the mock). */
export function itemFromSimplified(item: Record<string, unknown>): ItemData {
  const tag = asRecord(item.tag);
  const display = asRecord(tag.display);
  const ea = asRecord(tag.ExtraAttributes);

  const id = String(ea.id ?? 'UNKNOWN');
  const lore = Array.isArray(display.Lore) ? (display.Lore as unknown[]).map(String) : [];
  const rarity = rarityFromLore(lore) ?? (typeof ea.tier === 'string' ? ea.tier : undefined);
  const count = Math.max(1, asNumber(item.Count) || 1);
  const name = stripColor(String(display.Name ?? id));

  const gems: string[] = [];
  const gemsRaw = asRecord(ea.gems);
  for (const [slot, val] of Object.entries(gemsRaw)) {
    if (slot === 'unlocked_slots' || slot.endsWith('_gem')) continue;
    const quality = typeof val === 'string' ? val : String(asRecord(val).quality ?? '');
    if (!quality) continue;
    // Slot names look like COMBAT_0, RUBY_0, JASPER_1. Typed slots carry the gem type in <slot>_gem.
    const typeFromSlot = slot.replace(/_\d+$/, '');
    const explicit = gemsRaw[`${slot}_gem`];
    const gemType = typeof explicit === 'string' ? explicit : typeFromSlot;
    gems.push(`${gemType}:${quality}`);
  }
  gems.sort();

  let pet: ItemData['pet'];
  if (typeof ea.petInfo === 'string' && ea.petInfo.startsWith('{')) {
    try {
      const p = JSON.parse(ea.petInfo) as Record<string, unknown>;
      pet = {
        type: String(p.type ?? 'UNKNOWN'),
        tier: String(p.tier ?? ''),
        level: petLevelFromExp(asNumber(p.exp), String(p.tier ?? ''), String(p.type ?? '')),
        heldItem: typeof p.heldItem === 'string' ? p.heldItem : undefined,
        skin: typeof p.skin === 'string' ? p.skin : undefined,
        candyUsed: asNumber(p.candyUsed),
      };
    } catch { /* malformed petInfo: treat as petless */ }
  }

  const drillParts: string[] = [];
  for (const k of ['drill_part_upgrade_module', 'drill_part_fuel_tank', 'drill_part_engine']) {
    if (typeof ea[k] === 'string') drillParts.push(String(ea[k]));
  }
  drillParts.sort();

  const abilityScrolls = Array.isArray(ea.ability_scroll) ? (ea.ability_scroll as unknown[]).map(String).sort() : [];

  return {
    id,
    count,
    name,
    lore,
    color: typeof display.color === 'number' ? (display.color >>> 0 & 0xffffff).toString(16).toUpperCase().padStart(6, '0') : undefined,
    reforge: typeof ea.modifier === 'string' ? ea.modifier : undefined,
    enchants: numRecord(ea.enchantments),
    hotPotato: asNumber(ea.hot_potato_count),
    recombobulated: asNumber(ea.rarity_upgrades) > 0,
    stars: Math.max(asNumber(ea.upgrade_level), asNumber(ea.dungeon_item_level)),
    gems,
    attributes: numRecord(ea.attributes),
    pet,
    skin: typeof ea.skin === 'string' ? ea.skin : undefined,
    shiny: asNumber(ea.is_shiny) > 0,
    artOfWar: asNumber(ea.art_of_war_count),
    artOfPeace: asNumber(ea.artOfPeaceApplied) > 0,
    ethermerge: asNumber(ea.ethermerge) > 0,
    tunedTransmission: asNumber(ea.tuned_transmission),
    powerScroll: typeof ea.power_ability_scroll === 'string' ? ea.power_ability_scroll : undefined,
    abilityScrolls,
    drillParts,
    runes: numRecord(ea.runes),
    enrichment: typeof ea.talisman_enrichment === 'string' ? ea.talisman_enrichment : undefined,
    woodSingularity: asNumber(ea.wood_singularity_count) > 0,
    farmingForDummies: asNumber(ea.farming_for_dummies_count),
    dye: typeof ea.dye_item === 'string' ? ea.dye_item : undefined,
    statsBook: ea.stats_book !== undefined,
    winningBid: ea.winning_bid !== undefined ? asNumber(ea.winning_bid) + asNumber(ea.additional_coins) : undefined,
    cakeYear: ea.new_years_cake !== undefined ? asNumber(ea.new_years_cake) : undefined,
    edition: ea.edition !== undefined ? asNumber(ea.edition) : undefined,
    partyHatColor: typeof ea.party_hat_color === 'string' ? ea.party_hat_color : undefined,
    partyHatEmoji: typeof ea.party_hat_emoji === 'string' ? ea.party_hat_emoji : undefined,
    bossTier: ea.boss_tier !== undefined ? asNumber(ea.boss_tier) : undefined,
    manaDisintegrator: asNumber(ea.mana_disintegrator_count),
    jalapeno: asNumber(ea.jalapeno_count),
    polarvoid: asNumber(ea.polarvoid),
    divanPowderCoating: ea.divan_powder_coating !== undefined,
    thunderCharge: asNumber(ea.thunder_charge),
    rarity,
    raw: ea,
  };
}

// Pet level thresholds: cumulative exp needed per level, offset by rarity.
const PET_LEVELS = [
  100, 110, 120, 130, 145, 160, 175, 190, 210, 230, 250, 275, 300, 330, 360, 400, 440, 490, 540, 600, 660, 730, 800,
  880, 960, 1050, 1150, 1260, 1380, 1510, 1650, 1800, 1960, 2130, 2310, 2500, 2700, 2920, 3160, 3420, 3700, 4000,
  4350, 4750, 5200, 5700, 6300, 7000, 7800, 8700, 9700, 10800, 12000, 13300, 14700, 16200, 17800, 19500, 21300,
  23200, 25200, 27400, 29800, 32400, 35200, 38200, 41400, 44800, 48400, 52200, 56200, 60400, 64800, 69400, 74200,
  79200, 84700, 90700, 97200, 104200, 111700, 119700, 128200, 137200, 146700, 156700, 167700, 179700, 192700,
  206700, 221700, 237700, 254700, 272700, 291700, 311700, 333700, 357700, 383700, 411700, 441700, 476700, 516700,
  561700, 611700, 666700, 726700, 791700, 861700, 936700, 1016700, 1101700, 1191700, 1286700, 1386700, 1496700,
  1616700, 1746700, 1886700, 0,
];
const RARITY_OFFSET: Record<string, number> = { COMMON: 0, UNCOMMON: 6, RARE: 11, EPIC: 16, LEGENDARY: 20, MYTHIC: 20 };

/** Convert cumulative pet exp to a level (1..100, or up to 200 for Golden Dragon). */
export function petLevelFromExp(exp: number, tier: string, type: string): number {
  const offset = RARITY_OFFSET[tier] ?? 0;
  const maxLevel = type === 'GOLDEN_DRAGON' ? 200 : 100;
  let level = 1;
  let remaining = exp;
  for (let i = offset; i < PET_LEVELS.length && level < 100; i++) {
    const need = PET_LEVELS[i];
    if (need === 0 || remaining < need) return level;
    remaining -= need;
    level++;
  }
  // Golden Dragon: level 200 sits at 210,255,385 total exp; levels past 100 are modelled as
  // evenly spaced between the two known totals. Only the 100/150/200 buckets feed the price key.
  if (maxLevel > 100) {
    const perLevel = (210_255_385 - 25_353_230) / 100;
    level = Math.min(maxLevel, 100 + Math.floor(remaining / perLevel + 1e-9));
  }
  return level;
}
