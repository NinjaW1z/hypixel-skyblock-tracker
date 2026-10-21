import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, rankFlips, type DecisionContext } from '../decide.js';
import { DEFAULT_CONFIG } from '../config.js';
import { toFlip, toCreateAuction, decodeData } from '../feed.js';
import { durationPreset } from '../flipper.js';
import type { Flip } from '../types.js';

const now = 1_700_000_000_000;
function flip(over: Partial<Flip> = {}): Flip {
  return {
    uuid: 'a1', kind: 'SNIPE', itemId: 'HYPERION', ruleId: 'HYPERION', itemName: 'Hyperion', rarity: 'LEGENDARY', count: 1,
    price: 800_000_000, target: 900_000_000, profit: 80_000_000, profitPercent: 0.1, priceSource: 'sales', salesPerDay: 10, keyTier: 0,
    risk: 'LOW', whitelisted: false, seller: 's', latencyMs: 1_200, apiLastUpdated: now - 2_000, detectedAt: now - 1_000, ageMs: 5_000,
    end: now + 3_600_000, command: '/viewauction a1', ...over,
  };
}
function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return { cfg: { ...DEFAULT_CONFIG.buy }, now, purse: 1_000_000_000, open: [], recentBuys: [], lastBuyByItem: new Map(), seen: new Set(), cycle: now - 2_000, paused: false, ...over };
}

test('accepts a flip the backend sent', () => {
  assert.deepEqual(decide(flip(), ctx()), { buy: true, reason: 'ok' });
});

test('rejects on each safety guard', () => {
  assert.match(decide(flip(), ctx({ paused: true })).reason, /paused/);
  assert.match(decide(flip(), ctx({ seen: new Set(['a1']) })).reason, /already/);
  assert.match(decide(flip({ command: '/ah' }), ctx()).reason, /not a BIN/);
  assert.match(decide(flip(), ctx({ cfg: { ...DEFAULT_CONFIG.buy, maxPrice: 1_000 } })).reason, /maxPrice/);
  assert.match(decide(flip({ detectedAt: now - 60_000 }), ctx()).reason, /stale/);
  assert.ok(decide(flip({ detectedAt: now - 60_000, purchaseAt: now + 5_000 }), ctx()).buy, 'a bed flip still in the future is not stale');
  assert.match(decide(flip({ end: now + 500 }), ctx()).reason, /ending/);
  assert.match(decide(flip(), ctx({ purse: 800_500_000 })).reason, /reserve/);
  assert.match(decide(flip(), ctx({ cfg: { ...DEFAULT_CONFIG.buy, maxOpenFlips: 1 }, open: [{} as never] })).reason, /still open/);
  assert.match(decide(flip(), ctx({ recentBuys: new Array(40).fill({ ts: now - 10, price: 1, cycle: 0 }) })).reason, /last hour/);
  assert.match(decide(flip(), ctx({ cfg: { ...DEFAULT_CONFIG.buy, maxSpendPerHour: 1_000 } })).reason, /spend cap/);
  assert.match(decide(flip(), ctx({ recentBuys: [{ ts: now - 10, price: 1, cycle: now - 2_000 }, { ts: now - 5, price: 1, cycle: now - 2_000 }] })).reason, /this cycle/);
  assert.match(decide(flip(), ctx({ lastBuyByItem: new Map([['HYPERION', now - 1_000]]) })).reason, /cooldown/);
});

test('purse unknown does not block', () => {
  assert.ok(decide(flip(), ctx({ purse: undefined })).buy);
});

test('rankFlips prefers profit then earlier purchaseAt', () => {
  const r = rankFlips([flip({ uuid: 'x', profit: 1 }), flip({ uuid: 'y', profit: 9, purchaseAt: 50 }), flip({ uuid: 'z', profit: 9, purchaseAt: 10 })]);
  assert.deepEqual(r.map((f) => f.uuid), ['z', 'y', 'x']);
});

test('toFlip maps the BAF/Coflnet payload and our extras', () => {
  const f = toFlip({ id: 'u1', startingBid: 1_000_000, purchaseAt: '2030-01-01T00:00:00.000Z', itemName: 'Hyperion', target: 1_500_000, finder: 'MEDIAN', profit: 480_000, profitPerc: 48, risk: 'LOW', itemId: 'HYPERION', auction: { start: 123, end: 456, tag: 'HYPERION' } })!;
  assert.equal(f.uuid, 'u1'); assert.equal(f.price, 1_000_000); assert.equal(f.target, 1_500_000); assert.equal(f.kind, 'MEDIAN'); assert.equal(f.profit, 480_000);
  assert.equal(f.profitPercent, 0.48); assert.equal(f.risk, 'LOW'); assert.equal(f.itemId, 'HYPERION'); assert.equal(f.command, '/viewauction u1');
  assert.equal(f.purchaseAt, Date.parse('2030-01-01T00:00:00.000Z')); assert.equal(f.apiLastUpdated, 123); assert.equal(f.end, 456);
  // minimal Coflnet shape
  const g = toFlip({ uuid: 'u2', startingBid: 10, itemName: 'X', target: 20, purchaseAt: 1_700_000_000 })!;
  assert.equal(g.profit, 10); assert.equal(g.purchaseAt, 1_700_000_000_000); assert.equal(g.kind, 'SNIPE');
  assert.equal(toFlip({ itemName: 'no id' }), undefined);
  assert.deepEqual(toCreateAuction({ price: 1_470_000.7, slot: 36, duration: 48, itemName: 'Hyperion', id: 'uuid-1' }), { price: 1_470_000, slot: 36, duration: 48, itemName: 'Hyperion', id: 'uuid-1' });
  assert.equal(toCreateAuction({ price: 0, slot: 1 }), undefined);
  assert.deepEqual(decodeData('"{\\"a\\":1}"'), { a: 1 });
});

test('durationPreset names Hypixel presets', () => {
  assert.ok(durationPreset(48)!.test('48 Hours'));
  assert.ok(durationPreset(48)!.test('2 Days'));
  assert.ok(durationPreset(6)!.test('6 Hours'));
  assert.ok(!durationPreset(6)!.test('12 Hours'));
  assert.ok(durationPreset(168)!.test('7 Days'));
  assert.equal(durationPreset(0), undefined);
});
