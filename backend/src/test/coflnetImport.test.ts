import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoflnetExport, parseRange, mapTag, mapFilter } from '../flips/coflnetImport.js';

test('range syntax', () => {
  assert.deepEqual(parseRange('<500m'), { max: 500_000_000 });
  assert.deepEqual(parseRange('>5m'), { min: 5_000_000 });
  assert.deepEqual(parseRange('1-10'), { min: 1, max: 10 });
  assert.deepEqual(parseRange('200'), { min: 200, max: 200 });
  assert.deepEqual(parseRange('<1.1b'), { max: 1_100_000_000 });
  assert.deepEqual(parseRange('<0.027'), { max: 0.027 });
  assert.equal(parseRange('abc'), undefined);
});

test('tags map to our ids', () => {
  assert.equal(mapTag('HYPERION'), 'HYPERION');
  assert.equal(mapTag('PET_ENDER_DRAGON'), 'PET_ENDER_DRAGON');
  assert.equal(mapTag('ENCHANTMENT_ULTIMATE_WISE_5'), 'BOOK_ultimate_wise_5');
});

test('filters map, finder detection, unsupported tracking', () => {
  const { rule, dropped } = mapFilter({ StartingBid: '<850m', AbilityScroll: 'None', IsShiny: 'yes', DoNotRelist: 'true', CurrentMayor: 'Derpy' }, 'whitelist');
  assert.equal(rule.maxPrice, 850_000_000);
  assert.deepEqual(rule.abilityScrolls, []);
  assert.equal(rule.shiny, true);
  assert.equal(rule.finder, true);
  assert.deepEqual(dropped, ['CurrentMayor']);
  const bl = mapFilter({ ArmorSet: 'FAIRY', ForceBlacklist: 'true' }, 'blacklist');
  assert.equal(bl.rule.item, 'FAIRY_*');
  assert.equal(bl.rule.finder, undefined);
  const c = mapFilter({ FairyColor: 'Fairy:330066,4C0099', Candy: '0-0', PetItem: 'NOT_TIER_BOOST', Profit: '<1m', ProfitPercentage: '>20', Volume: '<2' }, 'blacklist');
  assert.deepEqual(c.rule.colors, ['330066', '4C0099']);
  assert.equal(c.rule.candyMax, 0);
  assert.equal(c.rule.petItem, '!PET_ITEM_TIER_BOOST');
  assert.equal(c.rule.maxProfit, 1_000_000);
  assert.equal(c.rule.minProfitPercent, 0.2);
  assert.equal(c.rule.maxSalesPerDay, 2);
});

test('full export: thresholds, lists, disabled, unsupported-only entries', () => {
  const r = parseCoflnetExport({
    minProfit: 1_500_000, minProfitPercent: 0, minVolume: 0, maxCost: 10_000_000_000, onlyBin: true, finders: 'FLIPPER,SNIPER',
    visibility: { lore: true },
    blacklist: [
      { filter: { ArmorSet: 'FAIRY', ForceBlacklist: 'true' }, tags: ['Fairy user'] },
      { filter: { ItemCategory: 'FURNITURE', ForceBlacklist: 'true' } },
      { tag: 'PET_SQUID', filter: { Profit: '<2m', FlipFinder: 'SNIPER' } },
      { filter: { CurrentMayor: 'Derpy', ForceBlacklist: 'true' } },
      { tag: 'DISABLED_THING', filter: {}, disabled: true },
    ],
    whitelist: [
      { tag: 'NECRON_HANDLE', filter: { StartingBid: '<800m', DoNotRelist: 'true' }, displayName: "Necron's Handle" },
      { tag: 'ENCHANTMENT_ULTIMATE_LEGION_5', filter: { StartingBid: '<30m' } },
      { filter: { PetSkin: 'SHEEP_NEON_GREEN', StartingBid: '<23m', Candy: '0-0' } },
      { filter: { CraftCostWeight: 'default:0.9', ForTag: 'DEFAULT', DoNotRelist: 'true' }, tags: ['Weight'] },
    ],
  });
  assert.equal(r.settingsPatch.minProfit, 1_500_000);
  assert.equal(r.settingsPatch.maxPrice, 0, '10b cap means unlimited');
  assert.deepEqual(r.settingsPatch.kinds, { SNIPE: true, MEDIAN: true });
  assert.equal(r.blacklist.length, 3);
  assert.equal(r.blacklist[0].item, 'FAIRY_*');
  assert.equal(r.blacklist[1].category, 'FURNITURE');
  assert.equal(r.blacklist[2].item, 'PET_SQUID'); assert.equal(r.blacklist[2].kind, 'SNIPE'); assert.equal(r.blacklist[2].maxProfit, 2_000_000);
  assert.equal(r.whitelist.length, 3);
  assert.equal(r.whitelist[0].item, 'NECRON_HANDLE'); assert.equal(r.whitelist[0].finder, true); assert.equal(r.whitelist[0].maxPrice, 800_000_000);
  assert.equal(r.whitelist[1].item, 'BOOK_ultimate_legion_5');
  assert.equal(r.whitelist[2].petSkin, 'SHEEP_NEON_GREEN'); assert.equal(r.whitelist[2].category, 'PET');
  assert.equal(r.imported, 6);
  assert.equal(r.skipped.length, 3, 'mayor-only, disabled, craftcost-only');
  assert.ok(r.unsupported.CurrentMayor === 1 && r.unsupported.CraftCostWeight === 1);
  assert.ok(r.notes.some((n) => n.includes('Display')));
});

test('ALL_EXCEPT_USER and skin filters', () => {
  const a = mapFilter({ FlipFinder: 'ALL_EXCEPT_USER', Profit: '<5m' }, 'blacklist');
  assert.equal(a.rule.kindNot, 'USER'); assert.equal(a.rule.maxProfit, 5_000_000); assert.deepEqual(a.dropped, []);
  assert.equal(mapFilter({ DragonArmorSkin: 'SUPERIOR_BABY', StartingBid: '<50m' }, 'whitelist').rule.skin, 'SUPERIOR_BABY');
});

test('garbage input does not throw', () => {
  assert.equal(parseCoflnetExport(null).imported, 0);
  assert.equal(parseCoflnetExport('x').imported, 0);
  assert.equal(parseCoflnetExport({ whitelist: 'nope', blacklist: [1, null] }).imported, 0);
});
