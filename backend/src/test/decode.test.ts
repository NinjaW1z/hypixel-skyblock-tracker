import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeItemBytes } from '../nbt/encode.js';
import { decodeItemBytes, petLevelFromExp, rarityFromLore } from '../nbt/decode.js';

test('decodes a modified weapon', () => {
  const b64 = encodeItemBytes({
    id: 'HYPERION', name: '§6Heroic Hyperion', rarity: 'LEGENDARY', count: 1,
    lore: ['§7Damage: §c+260', '', '§6§lLEGENDARY DUNGEON SWORD'],
    extra: { modifier: 'heroic', upgrade_level: 10, hot_potato_count: 15, rarity_upgrades: 1,
      enchantments: { ultimate_wise: 5, sharpness: 7 }, gems: { COMBAT_0: 'PERFECT', COMBAT_0_gem: 'JASPER', SAPPHIRE_0: { quality: 'FLAWLESS', uuid: 'x' } },
      ability_scroll: ['WITHER_SHIELD_SCROLL', 'IMPLOSION_SCROLL'] },
  });
  const it = decodeItemBytes(b64);
  assert.equal(it.id, 'HYPERION');
  assert.equal(it.name, 'Heroic Hyperion');
  assert.equal(it.reforge, 'heroic');
  assert.equal(it.stars, 10);
  assert.equal(it.hotPotato, 15);
  assert.equal(it.recombobulated, true);
  assert.deepEqual(it.enchants, { ultimate_wise: 5, sharpness: 7 });
  assert.deepEqual(it.gems, ['JASPER:PERFECT', 'SAPPHIRE:FLAWLESS']);
  assert.deepEqual(it.abilityScrolls, ['IMPLOSION_SCROLL', 'WITHER_SHIELD_SCROLL']);
  assert.equal(it.rarity, 'LEGENDARY');
});

test('decodes a pet with level from exp', () => {
  const b64 = encodeItemBytes({ id: 'PET', name: '§7[Lvl 100] §6Ender Dragon', rarity: 'LEGENDARY', lore: ['§6§lLEGENDARY'],
    extra: { petInfo: JSON.stringify({ type: 'ENDER_DRAGON', tier: 'LEGENDARY', exp: 25_353_230, heldItem: 'PET_ITEM_TIER_BOOST', candyUsed: 2 }) } });
  const it = decodeItemBytes(b64);
  assert.equal(it.pet?.type, 'ENDER_DRAGON');
  assert.equal(it.pet?.level, 100);
  assert.equal(it.pet?.heldItem, 'PET_ITEM_TIER_BOOST');
  assert.equal(it.pet?.candyUsed, 2);
});

test('pet levels', () => {
  assert.equal(petLevelFromExp(0, 'LEGENDARY', 'X'), 1);
  assert.equal(petLevelFromExp(25_353_230, 'LEGENDARY', 'X'), 100);
  assert.equal(petLevelFromExp(5_624_785, 'COMMON', 'X'), 100);
  assert.equal(petLevelFromExp(1_000_000, 'LEGENDARY', 'X') < 100, true);
  assert.equal(petLevelFromExp(210_255_385, 'LEGENDARY', 'GOLDEN_DRAGON'), 200);
});

test('stack count and rarity words', () => {
  const it = decodeItemBytes(encodeItemBytes({ id: 'RECOMBOBULATOR_3000', count: 16, lore: ['§5§lEPIC'] }));
  assert.equal(it.count, 16);
  assert.equal(it.rarity, 'EPIC');
  assert.equal(rarityFromLore(['§c§lVERY SPECIAL']), 'VERY_SPECIAL');
  assert.equal(rarityFromLore(['§6§lLEGENDARY HELMET']), 'LEGENDARY');
  assert.equal(rarityFromLore(['hello']), undefined);
});
