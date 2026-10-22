import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { startMockHypixel } from '../scripts/mock-hypixel-server.js';
import { DEFAULT_CONFIG, type BotConfig } from '../config.js';
import { BridgeClient, decodeData } from '../feed.js';
import { MinecraftClient } from '../minecraft.js';
import { Store } from '../store.js';
import { Flipper } from '../flipper.js';

const freePort = (): Promise<number> => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const until = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};
/** A BAF-protocol frame as the backend's bridge sends it. */
const frame = (type: string, data: unknown) => JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) });

test('buys, claims, lists on createAuction and books the sale against the mock server', { timeout: 90_000 }, async () => {
  const mcPort = await freePort();
  const wsPort = await freePort();
  const mock = startMockHypixel(mcPort);
  mock.state.auctions.set('a1', { id: 'a1', name: 'Hyperion', price: 1_000_000 });
  mock.state.auctions.set('a2', { id: 'a2', name: 'Valkyrie', price: 2_000_000 });

  // Fake bridge: records what the bot sends, pushes flips, answers inventory uploads with createAuction.
  const wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1' });
  const received: { type: string; data: unknown }[] = [];
  let client: WebSocket | undefined;
  let connectUrl = '';
  let createAuctionSent = false;
  wss.on('connection', (ws, req) => {
    client = ws; connectUrl = req.url ?? '';
    ws.send(frame('chatMessage', [{ text: 'welcome' }]));
    ws.on('message', (d) => {
      const f = JSON.parse(String(d));
      const data = decodeData(f.data);
      received.push({ type: f.type, data });
      if (f.type === 'uploadInventory' && !createAuctionSent) {
        const slots = (data as { slots: ({ slot: number; nbt?: unknown } | null)[] }).slots;
        const hit = slots.find((s) => s && JSON.stringify(s.nbt ?? '').includes('uuid-Hyperion'));
        if (hit) { createAuctionSent = true; ws.send(frame('createAuction', { price: 1_470_000, slot: hit.slot, duration: 48, itemName: 'Hyperion', id: 'uuid-Hyperion' })); }
      }
    });
  });

  const cfg: BotConfig = {
    ...DEFAULT_CONFIG, mode: 'live', dataDir: mkdtempSync(join(tmpdir(), 'skyflip-bot-')),
    feed: { url: `ws://127.0.0.1:${wsPort}/modsocket/tok`, token: '' },
    minecraft: { ...DEFAULT_CONFIG.minecraft, host: '127.0.0.1', port: mcPort, version: '1.8.9', account: 'Tester', authDir: '', homeCommand: '' },
    buy: { ...DEFAULT_CONFIG.buy, purseReserve: 100_000, maxBuysPerCycle: 5 },
    sell: { ...DEFAULT_CONFIG.sell, reserveAuctionSlots: 0 },
    timing: { ...DEFAULT_CONFIG.timing, commandDelayMs: 40, windowTimeoutMs: 2_000, chatTimeoutMs: 2_000, maintenanceIntervalMs: 1_000, refreshGuardMs: 0, antiAfk: false, scoreboardIntervalMs: 500 },
  };
  const store = new Store(cfg.dataDir);
  const feed = new BridgeClient(cfg.feed.url);
  const mc = new MinecraftClient({ host: cfg.minecraft.host, port: cfg.minecraft.port, version: cfg.minecraft.version, account: 'Tester', authDir: '', auth: 'offline', timing: cfg.timing });
  const flipper = new Flipper(cfg, feed, mc, store);
  flipper.start();
  try {
    await until(() => flipper.state === 'idle', 20_000, 'idle state');
    assert.match(connectUrl, /\/modsocket\/tok\?player=Tester&version=skyflip-bot/, 'connects as the logged-in player');
    await until(() => received.some((m) => m.type === 'uploadScoreboard'), 5_000, 'scoreboard upload');
    const sb = received.find((m) => m.type === 'uploadScoreboard')!.data as string[];
    assert.ok(sb.some((l) => /Purse: 10,000,000/.test(l)), `purse line in ${JSON.stringify(sb)}`);
    assert.equal(mc.purse(), 10_000_000);

    // 1. A flip arrives (BAF shape, bed 1 s ahead): buy it.
    client!.send(frame('flip', { id: 'a1', startingBid: 1_000_000, purchaseAt: new Date(Date.now() + 1_000).toISOString(), itemName: 'Hyperion', target: 1_500_000, profit: 480_000, finder: 'SNIPE', risk: 'LOW', itemId: 'HYPERION' }));
    await until(() => store.find('a1')?.state !== undefined, 10_000, 'purchase recorded');
    assert.equal(store.find('a1')!.state, 'bought');
    assert.equal(mock.state.purse, 9_000_000);
    assert.ok(mock.state.auctions.get('a1')!.sold);
    assert.deepEqual(mock.state.clicks.slice(0, 2), [{ title: 'BIN Auction View', slot: 31 }, { title: 'Confirm Purchase', slot: 11 }]);

    // 2. Maintenance claims it; the inventory upload makes the fake bridge send createAuction; the bot lists it.
    await until(() => store.find('a1')?.state === 'listed', 40_000, 'item listed');
    const p = store.find('a1')!;
    assert.equal(p.listPrice, 1_470_000);
    assert.equal(p.itemUuid, 'uuid-Hyperion');
    assert.deepEqual(mock.state.listings, [{ name: 'Hyperion', price: 1_470_000, bin: true, duration: '48 Hours', status: 'active' }]);
    assert.equal(mock.state.inventory.filter(Boolean).length, 0);
    assert.ok(received.some((m) => m.type === 'log' && /LISTED Hyperion/.test(String(m.data))), 'listing reported to the bridge');

    // 3. Someone buys it: the next review books the sale and claims the coins.
    mock.state.listings[0].status = 'sold';
    mock.state.listings[0].soldFor = 1_470_000;
    client!.send(frame('execute', 'claim'));
    await until(() => store.find('a1')?.state === 'sold', 30_000, 'sale booked');
    assert.equal(store.stats.sold, 1);
    assert.equal(mock.state.purse, 9_000_000 + 1_470_000);

    // 4. A flip that gets sniped between view and confirm is a clean failure.
    mock.state.snipeOnConfirm = true;
    client!.send(frame('flip', { id: 'a2', startingBid: 2_000_000, itemName: 'Valkyrie', target: 3_000_000 }));
    await until(() => store.stats.failed >= 1, 10_000, 'failed purchase');
    assert.equal(store.find('a2'), undefined);

    // 5. Pause via execute is honoured.
    client!.send(frame('execute', 'pause'));
    await new Promise((r) => setTimeout(r, 200));
    client!.send(frame('flip', { id: 'a3', startingBid: 10, itemName: 'X', target: 20 }));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(mock.state.log.filter((l) => l.includes('/viewauction a3')).length, 0);
  } finally {
    flipper.stop();
    feed.stop();
    wss.close();
    mock.close();
  }
});
