import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG, modsocketUrl } from '../config.js';
import { Store } from '../store.js';

test('config merges file over defaults and env over file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-bot-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ mode: 'offline', buy: { maxBuysPerCycle: 5 }, sell: { maxAuctionSlots: 28 } }));
  const c = loadConfig({ SKYFLIP_TOKEN: 'tok', DEBUG: '1' }, dir);
  assert.equal(c.mode, 'offline');
  assert.equal(c.feed.token, 'tok');
  assert.equal(c.debug, true);
  assert.equal(c.buy.maxBuysPerCycle, 5);
  assert.equal(c.buy.purseReserve, DEFAULT_CONFIG.buy.purseReserve);
  assert.equal(c.sell.maxAuctionSlots, 28);
  assert.equal(c.sell.reserveAuctionSlots, DEFAULT_CONFIG.sell.reserveAuctionSlots);
});

test('config requires an account unless offline, and a usable bridge url', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-bot-'));
  assert.throws(() => loadConfig({ BOT_MODE: 'dry', SKYFLIP_TOKEN: 't' }, dir), /minecraft\.account/);
  assert.doesNotThrow(() => loadConfig({ BOT_MODE: 'dry', MC_ACCOUNT: 'me@example.com', SKYFLIP_TOKEN: 't' }, dir));
  assert.throws(() => loadConfig({ BOT_MODE: 'yolo', MC_ACCOUNT: 'x', SKYFLIP_TOKEN: 't' }, dir), /mode must be/);
  assert.throws(() => loadConfig({ BOT_MODE: 'offline' }, dir), /feed\.url/);
  assert.doesNotThrow(() => loadConfig({ BOT_MODE: 'offline', WEBSOCKET_URL: 'ws://127.0.0.1:3131/modsocket/abc' }, dir));
});

test('modsocketUrl derives the bridge endpoint', () => {
  assert.equal(modsocketUrl('ws://h:3131/ws', 'tok'), 'ws://h:3131/modsocket/tok');
  assert.equal(modsocketUrl('ws://h:3131/modsocket/tok', ''), 'ws://h:3131/modsocket/tok');
  assert.equal(modsocketUrl('ws://h:3131/ws', ''), undefined);
  assert.equal(modsocketUrl('nope', 'tok'), undefined);
});

test('store round-trips purchases and stats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-bot-'));
  const s = new Store(dir);
  s.add({ auctionId: 'a', itemName: 'Hyperion', itemId: 'HYPERION', count: 1, price: 10, target: 20, boughtAt: 1, state: 'bought', listings: 0, kind: 'SNIPE' });
  s.stats.bought = 1;
  s.flush();
  const s2 = new Store(dir);
  assert.equal(s2.purchases.length, 1);
  assert.equal(s2.find('a')?.itemName, 'Hyperion');
  assert.equal(s2.stats.bought, 1);
  assert.equal(s2.open.length, 1);
  s2.find('a')!.state = 'sold';
  assert.equal(s2.open.length, 0);
});
