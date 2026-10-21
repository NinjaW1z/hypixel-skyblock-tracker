import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ModSocketBridge, listPrice, decodeData, parseInventory } from '../server/modsocket.js';
import { SettingsStore } from '../flips/settings.js';
import type { Flip } from '../flips/detector.js';
import type { Purchase } from '../flips/tracker.js';

const UUID = 'f3d28cb072253cb1baeb2dadd2be89ae';
class FakeTracker extends EventEmitter {
  tracked: string[] = [];
  flips = new Map<string, Flip>();
  track(u: string): void { this.tracked.push(u); }
  get trackedPlayers(): string[] { return this.tracked; }
  flipFor(id: string): Flip | undefined { return this.flips.get(id); }
}
function flip(over: Partial<Flip> = {}): Flip {
  const now = Date.now();
  return {
    uuid: 'a1', kind: 'SNIPE', itemId: 'HYPERION', ruleId: 'HYPERION', itemName: 'Hyperion', rarity: 'LEGENDARY', count: 1, price: 1_000_000, target: 1_500_000,
    profit: 600_000, profitPercent: 0.6, priceSource: 'sales', salesPerDay: 10, keyTier: 0, key: 'k', risk: 'LOW', whitelisted: false, seller: 's', latencyMs: 900,
    apiLastUpdated: now - 1_000, detectedAt: now, ageMs: 2_000, end: now + 3_600_000, command: '/viewauction a1', summary: '', lore: [], ...over,
  };
}
const frames = (ws: WebSocket) => { const out: { type: string; data: unknown }[] = []; ws.on('message', (d) => { const f = JSON.parse(String(d)); out.push({ type: f.type, data: decodeData(f.data) }); }); return out; };
const until = async (pred: () => boolean, ms = 3_000): Promise<void> => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-bridge-'));
  const settings = new SettingsStore(dir);
  const tracker = new FakeTracker();
  const open: Purchase[] = [];
  const webhooks: string[] = [];
  const bridge = new ModSocketBridge({
    token: 'secret', settings, tracker: tracker as never, mojang: { resolve: async () => UUID, remember() {} } as never,
    store: { openPurchases: () => open, loadFlip: () => undefined }, dataDir: dir, webhook: (t) => webhooks.push(t), inventoryDelayMs: 50, nudgeMs: 100,
  });
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  http.on('upgrade', (req, socket, head) => { const url = new URL(req.url ?? '/', 'http://x'); if (!bridge.handleUpgrade(req, socket, head, url.pathname)) socket.destroy(); });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const connect = (token = 'secret', player = 'Tester') => new WebSocket(`ws://127.0.0.1:${port}/modsocket/${token}?player=${player}&version=1.0&SId=abc`);
  const close = () => { bridge.close(); http.close(); };
  return { settings, tracker, bridge, connect, close, open, webhooks };
}

test('refuses a bad token and accepts the right one', async () => {
  const s = await setup();
  try {
    const bad = s.connect('wrong');
    const err = await new Promise<Error>((r) => bad.on('error', r));
    assert.match(err.message, /401/);
    const ws = s.connect();
    const got = frames(ws);
    await until(() => got.length > 0);
    assert.equal(got[0].type, 'chatMessage');
    await until(() => s.bridge.status().bots[0]?.uuid === UUID);
    assert.deepEqual(s.tracker.tracked, [UUID]);
    ws.close();
  } finally { s.close(); }
});

test('gates flips through autobuy settings and sends the BAF payload', async () => {
  const s = await setup();
  try {
    const ws = s.connect();
    const got = frames(ws);
    await until(() => s.bridge.status().bots[0]?.uuid === UUID);
    assert.deepEqual(s.bridge.publishFlip(flip()), { sent: 0, reason: 'autobuy off' });
    s.settings.update({ autobuy: { ...s.settings.current.autobuy, enabled: true } });
    assert.match(s.bridge.publishFlip(flip({ profit: 10_000, profitPercent: 0.01 })).reason!, /profit/);
    assert.match(s.bridge.publishFlip(flip({ risk: 'HIGH' })).reason!, /risk/);
    assert.match(s.bridge.publishFlip(flip({ priceSource: 'none' })).reason!, /no price reference/);
    assert.match(s.bridge.publishFlip(flip({ ageMs: 120_000 })).reason!, /old/);
    assert.deepEqual(s.bridge.publishFlip(flip()), { sent: 1 });
    assert.match(s.bridge.publishFlip(flip()).reason!, /already sent/);
    await until(() => got.some((f) => f.type === 'flip'));
    const f = got.find((f) => f.type === 'flip')!.data as Record<string, unknown>;
    assert.equal(f.id, 'a1'); assert.equal(f.uuid, 'a1'); assert.equal(f.startingBid, 1_000_000); assert.equal(f.target, 1_500_000); assert.equal(f.itemName, 'Hyperion'); assert.equal(f.finder, 'SNIPE');
    // bed: auction is 3 s old, bedDelay 20 s → purchaseAt ≈ 17 s ahead
    const wait = new Date(f.purchaseAt as string).getTime() - Date.now();
    assert.ok(wait > 15_000 && wait <= 18_000, `purchaseAt ${wait}ms ahead`);
    // raw frame has data as a JSON string
    ws.close();
  } finally { s.close(); }
});

test('purse reserve from the scoreboard upload blocks a flip', async () => {
  const s = await setup();
  try {
    const ws = s.connect();
    frames(ws);
    await until(() => s.bridge.status().bots[0]?.uuid === UUID);
    s.settings.update({ autobuy: { ...s.settings.current.autobuy, enabled: true, purseReserve: 500_000 } });
    ws.send(JSON.stringify({ type: 'uploadScoreboard', data: JSON.stringify(['§ePurse: §61,200,000', '§7⏣ §bYour Island']) }));
    await until(() => s.bridge.status().bots[0]?.purse === 1_200_000);
    assert.equal(s.bridge.status().bots[0].location, 'Your Island');
    assert.match(s.bridge.publishFlip(flip()).reason!, /no eligible bot/);
    assert.deepEqual(s.bridge.publishFlip(flip({ uuid: 'cheap', price: 600_000 })), { sent: 1 });
    ws.close();
  } finally { s.close(); }
});

test('sell loop: purchase → getInventory → createAuction by NBT uuid → sold clears the queue', async () => {
  const s = await setup();
  try {
    const ws = s.connect();
    const got = frames(ws);
    await until(() => s.bridge.status().bots[0]?.uuid === UUID);
    const fl = flip();
    s.tracker.flips.set('a1', fl);
    const p: Purchase = { auctionId: 'a1', player: UUID, itemId: 'HYPERION', itemName: 'Hyperion', itemUuid: 'item-uuid-1', price: 1_000_000, boughtAt: Date.now(), predictedProfit: fl.profit };
    s.tracker.emit('purchase', p, fl);
    await until(() => got.some((f) => f.type === 'getInventory'));
    assert.equal(s.bridge.status().pending.length, 1);
    assert.ok(s.webhooks.length === 0, 'no webhook url configured → nothing sent');
    const inventory = { slots: [null, { slot: 36, name: 'diamond_sword', count: 1, nbt: { type: 'compound', value: { ExtraAttributes: { type: 'compound', value: { id: { type: 'string', value: 'HYPERION' }, uuid: { type: 'string', value: 'item-uuid-1' } } } } } }], inventoryStart: 9 };
    ws.send(JSON.stringify({ type: 'uploadInventory', data: JSON.stringify(inventory) }));
    await until(() => got.some((f) => f.type === 'createAuction'));
    const ca = got.find((f) => f.type === 'createAuction')!.data as Record<string, unknown>;
    assert.deepEqual(ca, { price: listPrice({ cost: 1_000_000, target: 1_500_000, listings: 0 }, s.settings.current.autobuy), slot: 36, duration: 48, itemName: 'Hyperion', id: 'item-uuid-1' });
    assert.equal(ca.price, 1_470_000);
    assert.equal(s.bridge.status().pending[0].listings, 1);
    // a second upload right away does not re-list
    ws.send(JSON.stringify({ type: 'uploadInventory', data: JSON.stringify(inventory) }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got.filter((f) => f.type === 'createAuction').length, 1);
    s.tracker.emit('sold', { ...p, soldAt: Date.now(), soldPrice: 1_470_000, soldAuctionId: 'b1' });
    assert.equal(s.bridge.status().pending.length, 0);
    assert.ok(s.bridge.status().log.some((l) => /SOLD Hyperion/.test(l.text)));
    ws.close();
  } finally { s.close(); }
});

test('a bot that sends its own uuid skips the Mojang lookup', async () => {
  const s = await setup();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(s.connect().url).port}/modsocket/secret?player=Other&version=1&SId=x&uuid=0123456789abcdef0123456789abcdef`);
    await until(() => s.bridge.status().bots.some((b) => b.uuid === '0123456789abcdef0123456789abcdef'));
    assert.ok(s.tracker.tracked.includes('0123456789abcdef0123456789abcdef'));
    ws.close();
  } finally { s.close(); }
});

test('unsold purchases from before a restart are queued on connect', async () => {
  const s = await setup();
  try {
    s.open.push({ auctionId: 'old1', player: UUID, itemId: 'X', itemName: 'Old Thing', itemUuid: 'u-old', price: 100, boughtAt: Date.now() - 1000 });
    const ws = s.connect();
    const got = frames(ws);
    await until(() => got.some((f) => f.type === 'getInventory'));
    assert.equal(s.bridge.status().pending[0].auctionId, 'old1');
    ws.close();
  } finally { s.close(); }
});

test('listPrice, decodeData and parseInventory', () => {
  const ab = { undercutPercent: 0.02 };
  assert.equal(listPrice({ cost: 1_000_000, target: 1_500_000, listings: 0 }, ab), 1_470_000);
  assert.equal(listPrice({ cost: 1_000_000, target: 1_500_000, listings: 1 }, ab), Math.floor(1_500_000 * 0.98 * 0.95));
  assert.equal(listPrice({ cost: 1_000_000, target: 900_000, listings: 0 }, ab), 1_030_000);
  assert.equal(listPrice({ cost: 1_000_000, listings: 0 }, ab), 1_030_000);
  assert.deepEqual(decodeData('{"a":1}'), { a: 1 });
  assert.deepEqual(decodeData('"{\\"a\\":1}"'), { a: 1 });
  assert.equal(decodeData('plain'), 'plain');
  assert.equal(decodeData(''), '');
  const inv = parseInventory(JSON.stringify([{ slot: 3, name: 'stone', count: 2, nbt: { type: 'compound', value: { display: { type: 'compound', value: { Name: { type: 'string', value: '§6Fancy' } } }, ExtraAttributes: { type: 'compound', value: { uuid: { type: 'string', value: 'u1' } } } } } }]));
  assert.deepEqual(inv, [{ slot: 3, name: 'Fancy', count: 2, skyblockId: undefined, uuid: 'u1' }]);
});
