import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BazaarService, productName } from '../bazaar/bazaarService.js';
import type { BazaarProduct, BazaarResponse } from '../bazaar/types.js';

function product(
  id: string,
  ask: number, // lowest sell offer = instabuy  (buy_summary[0])
  bid: number, // highest buy order = instasell (sell_summary[0])
  buyMovingWeek: number,
  sellMovingWeek: number,
  extra: Partial<BazaarProduct> = {},
): BazaarProduct {
  return {
    product_id: id,
    buy_summary: ask > 0 ? [{ amount: 10, pricePerUnit: ask, orders: 1 }, { amount: 5, pricePerUnit: ask + 1, orders: 1 }] : [],
    sell_summary: bid > 0 ? [{ amount: 10, pricePerUnit: bid, orders: 1 }, { amount: 5, pricePerUnit: bid - 1, orders: 1 }] : [],
    quick_status: {
      productId: id, sellPrice: bid, sellVolume: 100, sellMovingWeek, sellOrders: 7,
      buyPrice: ask, buyVolume: 100, buyMovingWeek, buyOrders: 11,
    },
    ...extra,
  };
}

function stub(responses: BazaarResponse[]) {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      return responses[Math.min(i++, responses.length - 1)] as unknown as T;
    },
  };
}

const FIXTURE: Record<string, BazaarProduct> = {
  // ask 1000, bid 900: buy order 900.1, sell offer 999.9, spread 99.8, tax 12.49875 -> profit 87.30125
  ENCHANTED_LAPIS_LAZULI_BLOCK: product('ENCHANTED_LAPIS_LAZULI_BLOCK', 1000, 900, 1_000_000, 500_000),
  // thin, wide: HIGH risk
  'INK_SACK:4': product('INK_SACK:4', 100, 40, 500, 2000),
  // negative spread: skipped
  WHEAT: product('WHEAT', 5, 5.2, 1_000_000, 1_000_000),
  // spread positive but eaten by tax: ask 100, bid 99 -> spread 0.8, tax 1.24875 -> skipped
  SEEDS: product('SEEDS', 100, 99, 1_000_000, 1_000_000),
  // no asks at all: skipped
  LONELY: product('LONELY', 0, 50, 1000, 1000),
  // manipulated: spread > 2x buy price with tiny volume
  DEAD_BOOK: product('DEAD_BOOK', 100_000, 1_000, 10, 10),
  // huge volume, tight spread: LOW risk, caps at maxUnitsPerHour
  ENCHANTED_COBBLESTONE: product('ENCHANTED_COBBLESTONE', 1200, 1000, 50_000_000, 40_000_000),
};

test('productName humanises ids', () => {
  assert.equal(productName('ENCHANTED_LAPIS_LAZULI_BLOCK'), 'Enchanted Lapis Lazuli Block');
  assert.equal(productName('INK_SACK:4'), 'Ink Sack 4');
  assert.equal(productName('LOG_2:1'), 'Log 2 1');
});

test('sides, prices and tax math', () => {
  const svc = new BazaarService(stub([]));
  const flips = svc.analyze(FIXTURE);
  const f = flips.find((x) => x.productId === 'ENCHANTED_LAPIS_LAZULI_BLOCK')!;
  assert.ok(f);
  assert.equal(f.instaBuy, 1000, 'lowest sell offer comes from buy_summary');
  assert.equal(f.instaSell, 900, 'highest buy order comes from sell_summary');
  assert.equal(f.buyOrderPrice, 900.1);
  assert.equal(f.sellOrderPrice, 999.9);
  assert.ok(Math.abs(f.spread - 99.8) < 1e-9);
  assert.ok(Math.abs(f.profitPerUnit - (99.8 - 999.9 * 0.0125)) < 1e-9);
  assert.ok(Math.abs(f.profitPercent - f.profitPerUnit / 900.1) < 1e-12);
  assert.equal(f.command, '/bz Enchanted Lapis Lazuli Block');
  assert.equal(f.buyOrders, 11);
  assert.equal(f.sellOrders, 7);
});

test('custom tax rate', () => {
  const svc = new BazaarService(stub([]), { taxRate: 0.01 });
  const f = svc.analyze(FIXTURE).find((x) => x.productId === 'ENCHANTED_LAPIS_LAZULI_BLOCK')!;
  assert.ok(Math.abs(f.profitPerUnit - (99.8 - 999.9 * 0.01)) < 1e-9);
});

test('unitsPerHour uses the thin side; profitPerHour is capped', () => {
  const svc = new BazaarService(stub([]), { maxUnitsPerHour: 5000 });
  const flips = svc.analyze(FIXTURE);
  const lapis = flips.find((x) => x.productId === 'ENCHANTED_LAPIS_LAZULI_BLOCK')!;
  assert.ok(Math.abs(lapis.unitsPerHour - 500_000 / 168) < 1e-9);
  assert.ok(Math.abs(lapis.profitPerHour - lapis.profitPerUnit * (500_000 / 168)) < 1e-6);
  const cobble = flips.find((x) => x.productId === 'ENCHANTED_COBBLESTONE')!;
  assert.ok(cobble.unitsPerHour > 5000);
  assert.ok(Math.abs(cobble.profitPerHour - cobble.profitPerUnit * 5000) < 1e-6, 'capped at maxUnitsPerHour');
});

test('risk buckets', () => {
  const svc = new BazaarService(stub([]));
  const by = Object.fromEntries(svc.analyze(FIXTURE).map((f) => [f.productId, f]));
  assert.equal(by['ENCHANTED_COBBLESTONE'].risk, 'LOW');
  assert.equal(by['INK_SACK:4'].risk, 'HIGH', 'spread > 50% and thin');
  // lapis: spread ratio ~11%, thin side 500k/week; unitsPerDay = 500000/168*24 = 71428; 10x = 714k > buyMovingWeek? buy=1M ok, sell=500k < 714k -> MEDIUM
  assert.equal(by['ENCHANTED_LAPIS_LAZULI_BLOCK'].risk, 'MEDIUM');
});

test('skips unprofitable, one-sided and manipulated products', () => {
  const svc = new BazaarService(stub([]));
  const ids = svc.analyze(FIXTURE).map((f) => f.productId);
  assert.ok(!ids.includes('WHEAT'), 'negative spread');
  assert.ok(!ids.includes('SEEDS'), 'spread eaten by tax');
  assert.ok(!ids.includes('LONELY'), 'no sell offers');
  assert.ok(!ids.includes('DEAD_BOOK'), 'manipulated');
  assert.deepEqual(ids.sort(), ['ENCHANTED_COBBLESTONE', 'ENCHANTED_LAPIS_LAZULI_BLOCK', 'INK_SACK:4']);
});

test('all() is sorted by profitPerHour and top() filters', async () => {
  const res: BazaarResponse = { success: true, lastUpdated: 1000, products: FIXTURE };
  const svc = new BazaarService(stub([res]));
  assert.equal(await svc.pollOnce(), true);
  const all = svc.all();
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].profitPerHour >= all[i].profitPerHour);
  assert.equal(all[0].productId, 'ENCHANTED_COBBLESTONE');

  assert.deepEqual(svc.top({ risk: 'LOW' }).map((f) => f.productId), ['ENCHANTED_COBBLESTONE']);
  assert.deepEqual(svc.top({ risk: 'MEDIUM' }).map((f) => f.productId).sort(), ['ENCHANTED_COBBLESTONE', 'ENCHANTED_LAPIS_LAZULI_BLOCK']);
  assert.deepEqual(svc.top({ maxPrice: 950 }).map((f) => f.productId).sort(), ['ENCHANTED_LAPIS_LAZULI_BLOCK', 'INK_SACK:4']);
  assert.deepEqual(svc.top({ minVolumeWeek: 1_000_000 }).map((f) => f.productId), ['ENCHANTED_COBBLESTONE']);
  assert.equal(svc.top({ limit: 1 }).length, 1);
  assert.deepEqual(svc.top({ minProfitPercent: 0.5 }).map((f) => f.productId), ['INK_SACK:4']);
  assert.equal(svc.top({ minProfitPerHour: 1e12 }).length, 0);
});

test('pollOnce returns false when lastUpdated is unchanged and emits update on change', async () => {
  const a: BazaarResponse = { success: true, lastUpdated: 1000, products: FIXTURE };
  const b: BazaarResponse = { success: true, lastUpdated: 2000, products: FIXTURE };
  const client = stub([a, a, b]);
  const svc = new BazaarService(client);
  let updates = 0;
  svc.on('update', () => updates++);
  assert.equal(await svc.pollOnce(), true);
  assert.equal(await svc.pollOnce(), false, 'same lastUpdated');
  assert.equal(await svc.pollOnce(), true);
  assert.equal(updates, 2);
  assert.equal(svc.lastUpdated, 2000);
  assert.equal(svc.productCount, Object.keys(FIXTURE).length);
  assert.deepEqual(client.calls, ['/skyblock/bazaar', '/skyblock/bazaar', '/skyblock/bazaar']);
});
