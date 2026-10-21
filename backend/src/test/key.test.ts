import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeItemBytes } from '../nbt/encode.js';
import { decodeItemBytes } from '../nbt/decode.js';
import { buildKeys, KEY_TIERS } from '../pricing/key.js';

const keysFor = (spec: Parameters<typeof encodeItemBytes>[0]) => {
  const it = decodeItemBytes(encodeItemBytes(spec));
  return buildKeys(it, spec.rarity ?? 'COMMON');
};

test('tiers are strictly coarser and end with the item id', () => {
  const k = keysFor({ id: 'HYPERION', rarity: 'LEGENDARY', extra: { modifier: 'heroic', upgrade_level: 10, rarity_upgrades: 1, hot_potato_count: 15, enchantments: { ultimate_wise: 5, sharpness: 7, critical: 6 } } });
  assert.equal(k.length, KEY_TIERS);
  for (let i = 1; i < k.length; i++) assert.ok(k[i].length <= k[i - 1].length, `tier ${i} not coarser`);
  assert.equal(k[KEY_TIERS - 1], 'HYPERION');
  assert.equal(k[3], 'HYPERION|LEGENDARY');
  assert.ok(k[2].includes('S10') && k[2].includes('E:ultimate_wise5') && !k[2].includes('R:heroic'));
  assert.ok(k[1].includes('R:heroic') && k[1].includes('RC') && k[1].includes('HPB15') && k[1].includes('E:sharpness7'));
  assert.ok(k[0].includes('E:critical6'));
  assert.ok(!k[1].includes('E:critical6'));
});

test('same item, different stars, share coarser keys only', () => {
  const a = keysFor({ id: 'NECRON_CHESTPLATE', rarity: 'LEGENDARY', extra: { upgrade_level: 5 } });
  const b = keysFor({ id: 'NECRON_CHESTPLATE', rarity: 'LEGENDARY', extra: { upgrade_level: 10 } });
  assert.notEqual(a[0], b[0]);
  assert.notEqual(a[2], b[2]);
  assert.equal(a[3], b[3]);
});

test('enchanted books key on their enchant', () => {
  const k = keysFor({ id: 'ENCHANTED_BOOK', rarity: 'EPIC', extra: { enchantments: { ultimate_legion: 5 } } });
  assert.equal(k[4], 'BOOK_ultimate_legion_5');
  const multi = keysFor({ id: 'ENCHANTED_BOOK', rarity: 'EPIC', extra: { enchantments: { sharpness: 5, critical: 5 } } });
  assert.equal(multi[4], 'BOOK_MULTI');
  assert.ok(multi[3].includes('critical5,sharpness5'));
});

test('pets key on type, rarity, level bucket, skin, held item', () => {
  const k = keysFor({ id: 'PET', rarity: 'LEGENDARY', extra: { petInfo: JSON.stringify({ type: 'ENDER_DRAGON', tier: 'LEGENDARY', exp: 25_353_230, skin: 'ENDER_DRAGON_BABY', heldItem: 'PET_ITEM_LUCKY_CLOVER' }) } });
  assert.equal(k[4], 'PET_ENDER_DRAGON');
  assert.equal(k[3], 'PET_ENDER_DRAGON|LEGENDARY|L100');
  assert.ok(k[2].includes('PSKIN:ENDER_DRAGON_BABY'));
  assert.ok(k[1].includes('HELD:PET_ITEM_LUCKY_CLOVER') && !k[2].includes('HELD:'));
});

test('attribute gear keeps attributes through tier 2 and names at tier 3', () => {
  const k = keysFor({ id: 'INFERNAL_CRIMSON_CHESTPLATE', rarity: 'LEGENDARY', extra: { attributes: { veteran: 5, magic_find: 7 } } });
  assert.ok(k[2].includes('A:magic_find7,veteran5'));
  assert.ok(k[3].includes('AN:magic_find,veteran') && !k[3].includes('A:magic_find7'));
});

test('midas sword buckets paid coins; cakes key on year', () => {
  assert.ok(keysFor({ id: 'MIDAS_SWORD', rarity: 'LEGENDARY', extra: { winning_bid: 50_000_000 } })[2].includes('MIDAS50M'));
  assert.equal(keysFor({ id: 'NEW_YEAR_CAKE', rarity: 'SPECIAL', extra: { new_years_cake: 3 } })[4], 'NEW_YEAR_CAKE_3');
});
