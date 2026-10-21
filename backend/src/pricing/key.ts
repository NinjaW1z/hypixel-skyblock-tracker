import type { ItemData } from '../nbt/decode.js';

/**
 * Comparable-item keys at decreasing specificity.
 *
 * Tier 0 encodes every modifier that moves price. Each coarser tier drops the
 * least important modifiers so low-volume items still find comparables. Because
 * nearly every dropped modifier adds value, a coarse-tier price is a lower bound
 * on the item's worth, which is exactly the conservative direction a flipper wants.
 */
export const KEY_TIERS = 5;

/** Enchants whose presence at these levels materially changes price. */
const ULTIMATE_PREFIX = 'ultimate_';
const VALUABLE_AT_LEVEL: Record<string, number> = {
  // level >= this is key-worthy at tier 0
  first_strike: 5, triple_strike: 5, syphon: 5, vicious: 5, scavenger: 5, looting: 5, dragon_hunter: 5,
  overload: 5, chance: 5, counter_strike: 5, big_brain: 5, pristine: 5, rejuvenate: 5, snipe: 4,
  luck: 7, thunderlord: 7, smite: 7, bane_of_arthropods: 7, sharpness: 7, protection: 7, growth: 7,
  critical: 7, giant_killer: 7, ender_slayer: 7, power: 7, vampirism: 7, thunderbolt: 7, cubism: 6,
  execute: 6, lethality: 6, prosecute: 6, titan_killer: 7, venomous: 6, fire_aspect: 3, life_steal: 5,
  mana_steal: 3, tabasco: 3, infinite_quiver: 10, ferocious_mana: 10, mana_vampire: 10, strong_mana: 10,
  hardened_mana: 10, compact: 8, cultivating: 8, expertise: 8, champion: 8, hecatomb: 8, toxophilite: 8,
  efficiency: 10, true_protection: 1, smelting_touch: 1, lure: 6, turbo_cactus: 5, turbo_cane: 5,
  turbo_carrot: 5, turbo_coco: 5, turbo_melon: 5, turbo_mushrooms: 5, turbo_potato: 5, turbo_pumpkin: 5,
  turbo_warts: 5, turbo_wheat: 5, dedication: 4, delicate: 5, replenish: 1, sunder: 6, harvesting: 6,
  divine_gift: 3, paleontologist: 7, piscary: 6, charm: 5, spiked_hook: 6, frail: 6, angler: 6, blessing: 6,
  caster: 6, corruption: 5, double_hook: 4, fishing_speed: 6, magnet: 6, quantum: 5, reflection: 5, 
  green_thumb: 5, pesterminator: 6, transylvanian: 5, cayenne: 5, 
};

function enchantValueClass(name: string, level: number): 0 | 1 | 2 | 3 {
  // 3 = ultimate (survives to tier 2), 2 = very valuable (tier 1), 1 = valuable (tier 0), 0 = ignore
  if (level <= 0) return 0;
  if (name.startsWith(ULTIMATE_PREFIX)) return 3;
  const thr = VALUABLE_AT_LEVEL[name];
  if (thr !== undefined && level >= thr) return level > thr || level >= 7 ? 2 : 1;
  if (level >= 7) return 2;
  if (level >= 6) return 1;
  return 0;
}

function petLevelBucket(level: number, type: string): string {
  if (type === 'GOLDEN_DRAGON') {
    if (level >= 200) return 'L200';
    if (level >= 150) return 'L150';
    if (level >= 100) return 'L100';
  }
  if (level >= 100) return 'L100';
  if (level >= 90) return 'L90';
  if (level >= 70) return 'L70';
  if (level >= 50) return 'L50';
  if (level >= 25) return 'L25';
  return 'L1';
}

function hpbBucket(n: number): string | undefined {
  if (n >= 15) return 'HPB15';
  if (n >= 10) return 'HPB10';
  if (n > 0) return 'HPB';
  return undefined;
}

function midasBucket(coins: number): string {
  if (coins >= 100_000_000) return 'MIDAS100M';
  if (coins >= 50_000_000) return 'MIDAS50M';
  return `MIDAS${Math.floor(coins / 10_000_000) * 10}M`;
}

interface Part { v: string; maxTier: number }

/**
 * Build keys for tiers 0..KEY_TIERS-1. Index 0 is most specific.
 * `rarity` comes from the auction's `tier` field, which reflects recombobulation.
 */
export function buildKeys(item: ItemData, rarity: string): string[] {
  const parts: Part[] = [];
  const add = (v: string | undefined, maxTier: number) => { if (v) parts.push({ v, maxTier }); };

  // ---- base identity (every tier) ----
  let base = item.id;
  if (item.id === 'PET' && item.pet) base = `PET_${item.pet.type}`;
  else if (item.id === 'ENCHANTED_BOOK') {
    const e = Object.entries(item.enchants).sort(([a], [b]) => (a < b ? -1 : 1));
    base = e.length === 1 ? `BOOK_${e[0][0]}_${e[0][1]}` : e.length === 0 ? 'BOOK_EMPTY' : `BOOK_MULTI`;
    if (e.length > 1) add(e.map(([n, l]) => `${n}${l}`).join(','), 3);
  } else if (item.id === 'RUNE' || item.id.endsWith('_RUNE')) {
    const e = Object.entries(item.runes);
    if (e.length) base = `RUNE_${e[0][0]}_${e[0][1]}`;
  } else if (item.id === 'NEW_YEAR_CAKE' && item.cakeYear !== undefined) base = `NEW_YEAR_CAKE_${item.cakeYear}`;
  else if (item.id === 'PARTY_HAT_CRAB' || item.id === 'PARTY_HAT_CRAB_ANIMATED' || item.id === 'PARTY_HAT_SLOTH') {
    if (item.partyHatColor) base = `${item.id}_${item.partyHatColor}`;
    if (item.partyHatEmoji) base = `${base}_${item.partyHatEmoji}`;
  } else if (item.bossTier !== undefined) base = `${item.id}_T${item.bossTier}`;
  add(base, KEY_TIERS - 1);

  // ---- rarity (tiers 0-3) ----
  add(rarity, 3);

  // ---- pets ----
  if (item.pet) {
    add(petLevelBucket(item.pet.level, item.pet.type), 3);
    add(item.pet.skin ? `PSKIN:${item.pet.skin}` : undefined, 2);
    add(item.pet.heldItem ? `HELD:${item.pet.heldItem}` : undefined, 1);
    add(item.pet.candyUsed > 0 ? 'CANDY' : undefined, 0);
  }

  // ---- stars / upgrades ----
  add(item.stars > 0 ? `S${item.stars}` : undefined, 2);
  add(item.recombobulated ? 'RC' : undefined, 1);
  add(hpbBucket(item.hotPotato), 1);
  add(item.reforge ? `R:${item.reforge}` : undefined, 1);

  // ---- enchants ----
  const ench = Object.entries(item.enchants)
    .map(([n, l]) => ({ n, l, c: enchantValueClass(n, l) }))
    .filter((e) => e.c > 0)
    .sort((a, b) => (a.n < b.n ? -1 : 1));
  if (item.id !== 'ENCHANTED_BOOK') {
    for (const e of ench) {
      const v = `E:${e.n}${e.l}`;
      add(v, e.c === 3 ? 2 : e.c === 2 ? 1 : 0);
    }
  }

  // ---- gems ----
  if (item.gems.length) {
    add(`G:${item.gems.join(',')}`, 0);
    const top = item.gems.filter((g) => g.endsWith(':PERFECT') || g.endsWith(':FLAWLESS')).length;
    add(top > 0 ? `GTOP${top}` : undefined, 1);
  }

  // ---- attributes (Kuudra gear, shards) ----
  const attrs = Object.entries(item.attributes).sort(([a], [b]) => (a < b ? -1 : 1));
  if (attrs.length) {
    add(`A:${attrs.map(([n, l]) => `${n}${l}`).join(',')}`, 2);
    // At tier 3 keep attribute names only; price of an attribute piece is mostly its roll.
    add(`AN:${attrs.map(([n]) => n).join(',')}`, 3);
  }

  // ---- cosmetics & misc value adds ----
  add(item.skin ? `SKIN:${item.skin}` : undefined, 2);
  add(item.dye ? `DYE:${item.dye}` : undefined, 2);
  add(item.winningBid !== undefined ? midasBucket(item.winningBid) : undefined, 2);
  add(item.edition !== undefined ? (item.edition < 100 ? 'ED<100' : item.edition < 1000 ? 'ED<1000' : 'ED') : undefined, 1);
  add(item.artOfWar > 0 ? `AOW${item.artOfWar}` : undefined, 1);
  add(item.artOfPeace ? 'AOP' : undefined, 0);
  add(item.ethermerge ? 'ETHER' : undefined, 1);
  add(item.tunedTransmission > 0 ? `TT${item.tunedTransmission}` : undefined, 0);
  add(item.powerScroll ? `PS:${item.powerScroll}` : undefined, 1);
  add(item.abilityScrolls.length ? `AS:${item.abilityScrolls.join(',')}` : undefined, 1);
  add(item.drillParts.length ? `DP:${item.drillParts.join(',')}` : undefined, 1);
  const runes = Object.entries(item.runes);
  if (runes.length && item.id !== 'RUNE' && !item.id.endsWith('_RUNE')) add(`RUNE:${runes[0][0]}${runes[0][1]}`, 0);
  add(item.enrichment ? `ENR:${item.enrichment}` : undefined, 0);
  add(item.woodSingularity ? 'WS' : undefined, 0);
  add(item.farmingForDummies > 0 ? `FFD${item.farmingForDummies}` : undefined, 0);
  add(item.statsBook ? 'SB' : undefined, 0);
  add(item.manaDisintegrator > 0 ? `MD${item.manaDisintegrator}` : undefined, 0);
  add(item.jalapeno > 0 ? `JAL${item.jalapeno}` : undefined, 0);
  add(item.polarvoid > 0 ? `PV${item.polarvoid}` : undefined, 0);
  add(item.divanPowderCoating ? 'DPC' : undefined, 0);
  add(item.thunderCharge > 0 ? `TC${Math.min(5, Math.floor(item.thunderCharge / 1_000_000))}M` : undefined, 0);

  const keys: string[] = [];
  for (let t = 0; t < KEY_TIERS; t++) {
    keys.push(parts.filter((p) => p.maxTier >= t).map((p) => p.v).join('|'));
  }
  return keys;
}
