import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoflnetPrices, coflnetTag } from '../pricing/coflnet.js';

type Hit = { url: string };
function fakeFetch(responder: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const hits: Hit[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    hits.push({ url });
    const r = responder(url);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, hits };
}
const ok = (median: number) => ({ status: 200, body: { min: median / 2, median, mean: median, mode: median, volume: 12.5, max: median * 2 } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('tag mapping', () => {
  assert.equal(coflnetTag('HYPERION', { enchants: {} }), 'HYPERION');
  assert.equal(coflnetTag('PET', { pet: { type: 'ENDER_DRAGON' }, enchants: {} }), 'PET_ENDER_DRAGON');
  assert.equal(coflnetTag('PET', { enchants: {} }), undefined);
  assert.equal(coflnetTag('ENCHANTED_BOOK', { enchants: { ultimate_wise: 5 } }), 'ENCHANTMENT_ULTIMATE_WISE_5');
  assert.equal(coflnetTag('ENCHANTED_BOOK', { enchants: { sharpness: 5, critical: 5 } }), undefined);
  assert.equal(coflnetTag('RUNE', { enchants: {}, runes: { MUSIC: 3 } }), 'RUNE_MUSIC');
  assert.equal(coflnetTag('POTION', { enchants: {}, raw: { potion: 'speed' } }), 'POTION_SPEED');
});

test('request fetches once, get serves from cache, rarity is a query param', async () => {
  const { fetchImpl, hits } = fakeFetch(() => ok(1000));
  const c = new CoflnetPrices({ fetch: fetchImpl as never, requestsPerMinute: 6000, baseUrl: 'http://x/api' });
  c.start();
  assert.equal(c.get('HYPERION', 'LEGENDARY'), undefined);
  c.request('HYPERION', 'LEGENDARY');
  c.request('HYPERION', 'LEGENDARY'); // dedup
  await wait(40);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, 'http://x/api/item/price/HYPERION?Rarity=LEGENDARY');
  const p = c.get('HYPERION', 'LEGENDARY');
  assert.ok(p);
  assert.equal(p.median, 1000);
  assert.equal(p.volume, 12.5);
  assert.equal(p.source, 'coflnet');
  c.request('HYPERION', 'LEGENDARY');
  await wait(20);
  assert.equal(hits.length, 1, 'cached, no refetch');
  assert.equal(c.stats.cacheSize, 1);
  c.stop();
});

test('TTL expiry returns undefined and re-queues', async () => {
  let now = 1_000_000;
  const { fetchImpl, hits } = fakeFetch(() => ok(5));
  const c = new CoflnetPrices({ fetch: fetchImpl as never, requestsPerMinute: 6000, cacheTtlMs: 1000, now: () => now, baseUrl: 'http://x/api' });
  c.start();
  c.request('TERMINATOR');
  await wait(30);
  assert.ok(c.get('TERMINATOR'));
  now += 2000;
  assert.equal(c.get('TERMINATOR'), undefined, 'expired');
  await wait(30);
  assert.equal(hits.length, 2, 'expiry triggered a refetch');
  assert.ok(c.get('TERMINATOR'));
  c.stop();
});

test('pacing: requests are spaced by the configured rate, newest request first', async () => {
  const { fetchImpl, hits } = fakeFetch(() => ok(1));
  // 1200/min = one every 50ms
  const c = new CoflnetPrices({ fetch: fetchImpl as never, requestsPerMinute: 1200, baseUrl: 'http://x/api' });
  c.start();
  c.request('A'); c.request('B'); c.request('C');
  await wait(20);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].url.endsWith('/C'), 'most recently requested first');
  await wait(60);
  assert.equal(hits.length, 2);
  await wait(60);
  assert.equal(hits.length, 3);
  assert.equal(c.stats.queueSize, 0);
  c.stop();
});

test('429 pauses the queue for Retry-After and retries the item', async () => {
  let calls = 0;
  const { fetchImpl, hits } = fakeFetch(() => (++calls === 1 ? { status: 429, headers: { 'retry-after': '0.1' } } : ok(7)));
  const c = new CoflnetPrices({ fetch: fetchImpl as never, requestsPerMinute: 6000, baseUrl: 'http://x/api' });
  c.start();
  c.request('X');
  await wait(30);
  assert.equal(hits.length, 1);
  assert.equal(c.stats.rateLimited, 1);
  assert.equal(c.get('X'), undefined);
  await wait(60);
  assert.equal(hits.length, 1, 'still paused');
  await wait(80);
  assert.equal(hits.length, 2, 'retried after pause');
  assert.equal(c.get('X')?.median, 7);
  c.stop();
});

test('400 (unknown item) is cached as no-data and not retried', async () => {
  const { fetchImpl, hits } = fakeFetch(() => ({ status: 400, body: { slug: 'item_not_found' } }));
  const c = new CoflnetPrices({ fetch: fetchImpl as never, requestsPerMinute: 6000, baseUrl: 'http://x/api' });
  c.start();
  c.request('NOPE');
  await wait(30);
  assert.equal(hits.length, 1);
  const p = c.get('NOPE');
  assert.ok(p);
  assert.equal(p.median, 0);
  assert.equal(p.volume, 0);
  c.request('NOPE');
  await wait(20);
  assert.equal(hits.length, 1);
  c.stop();
});

test('queue is bounded; nothing runs before start()', async () => {
  const { fetchImpl, hits } = fakeFetch(() => ok(1));
  const c = new CoflnetPrices({ fetch: fetchImpl as never, requestsPerMinute: 6000, maxQueue: 3, baseUrl: 'http://x/api' });
  for (let i = 0; i < 10; i++) c.request(`T${i}`);
  assert.equal(c.stats.queueSize, 3);
  await wait(20);
  assert.equal(hits.length, 0, 'not started');
  c.start();
  await wait(60);
  assert.equal(hits.length, 3);
  assert.ok(hits.map((h) => h.url).some((u) => u.endsWith('/T9')));
  c.stop();
});
