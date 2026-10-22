import test from 'node:test';
import assert from 'node:assert/strict';
import { itemText, findSlot, priceInLore, isPlaceholder, containerSize, dumpWindow, sameItemName, GUI, type WindowLike, type ItemLike } from '../gui.js';

/** Build a 1.8-style NBT item the way prismarine-item exposes it. */
function nbtItem(name: string, lore: string[] = [], extra: Record<string, string> = {}, mcName = 'gold_ingot'): ItemLike {
  const ea: Record<string, { type: string; value: string }> = {};
  for (const [k, v] of Object.entries(extra)) ea[k] = { type: 'string', value: v };
  return {
    name: mcName, count: 1,
    nbt: { type: 'compound', name: '', value: { display: { type: 'compound', value: { Name: { type: 'string', value: name }, Lore: { type: 'list', value: { type: 'string', value: lore } } } }, ExtraAttributes: { type: 'compound', value: ea } } },
  };
}
function chest(title: string, rows: number, items: Record<number, ItemLike>): WindowLike {
  const slots: (ItemLike | null)[] = new Array(rows * 9 + 36).fill(null);
  for (const [i, it] of Object.entries(items)) slots[Number(i)] = it;
  return { id: 1, title, slots };
}

test('itemText reads name, lore and ExtraAttributes from 1.8 NBT', () => {
  const t = itemText(nbtItem('§6Hyperion', ['§7Lore 1', '§8Lore 2'], { id: 'HYPERION', uuid: 'abc-123' }));
  assert.deepEqual(t, { name: '§6Hyperion', lore: ['§7Lore 1', '§8Lore 2'], skyblockId: 'HYPERION', uuid: 'abc-123' });
});

test('itemText tolerates JSON text and missing nbt', () => {
  const t = itemText({ name: 'stone', displayName: 'Stone', nbt: { type: 'compound', value: { display: { type: 'compound', value: { Name: { type: 'string', value: '{"text":"Fancy","extra":[{"text":" Stone"}]}' } } } } } });
  assert.equal(t?.name, 'Fancy Stone');
  assert.equal(itemText({ name: 'stone', displayName: 'Stone' })?.name, 'Stone');
  assert.equal(itemText(null), undefined);
});

test('findSlot by name, lore and fallback', () => {
  const w = chest('BIN Auction View', 6, { 13: nbtItem('§6Hyperion', ['§7Lore']), 31: nbtItem('§6Buy Item Right Now', ['§7Price: §61,234,567 coins']), 49: nbtItem('§aGo Back') });
  assert.equal(findSlot(w, GUI.binView.buy)?.slot, 31);
  assert.equal(findSlot(w, { lore: /price:/i })?.slot, 31);
  assert.equal(findSlot(w, { name: /nothing like this/i, fallback: 49 })?.slot, 49);
  assert.equal(findSlot(w, { name: /nothing like this/i, fallback: 50 }), undefined);
  assert.equal(priceInLore(findSlot(w, GUI.binView.buy)), 1_234_567);
  assert.equal(containerSize(w), 54);
  assert.match(dumpWindow(w), /"BIN Auction View" \[13:Hyperion, 31:Buy Item Right Now, 49:Go Back\]/);
});

test('findSlot ignores the player inventory part by default', () => {
  const w = chest('Create BIN Auction', 6, { 60: nbtItem('§6Create BIN Auction') });
  assert.equal(findSlot(w, GUI.create.create), undefined);
  assert.equal(findSlot(w, { ...GUI.create.create, containerOnly: false })?.slot, 60);
});

test('placeholders', () => {
  const w = chest('Auction House', 6, { 13: nbtItem('§7Loading...', [], {}, 'stained_glass_pane'), 15: nbtItem(' ', [], {}, 'stained_glass_pane') });
  assert.ok(isPlaceholder(findSlot(w, { fallback: 13 })));
  assert.ok(isPlaceholder(findSlot(w, { fallback: 15 })));
  assert.ok(isPlaceholder(undefined));
  assert.ok(!isPlaceholder({ slot: 1, item: nbtItem('§aView Bids'), text: { name: '§aView Bids', lore: [] } }));
});

test('sameItemName is colour- and star-insensitive', () => {
  assert.ok(sameItemName('§6Hyperion §6✪✪✪✪✪', 'Hyperion'));
  assert.ok(sameItemName('[Lvl 100] Ender Dragon', '§6[Lvl 100] Ender Dragon'));
  assert.ok(!sameItemName('Hyperion', 'Valkyrie'));
  assert.ok(!sameItemName('', 'Valkyrie'));
});
