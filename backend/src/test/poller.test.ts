import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuctionPoller } from '../ingest/auctionPoller.js';
import { LowestBinBook } from '../pricing/priceBook.js';
import { auction } from './helpers.js';
import type { AuctionsPage } from '../hypixel/types.js';
import type { HypixelClient } from '../hypixel/client.js';

/** Fake client: two snapshots, page 1 of the second is stale on first read. */
function fakeClient(snap1: AuctionsPage[], snap2: AuctionsPage[]) {
  let phase = 1;
  let stale = true;
  const calls: string[] = [];
  const c = {
    requests: 0, bytesIn: 0,
    async auctionsPage(p: number) {
      calls.push(`p${p}`);
      const s = phase === 1 ? snap1 : snap2;
      return s[p];
    },
    // Mirrors HypixelClient.auctionsPageFor: re-fetch until the page carries the wanted snapshot.
    async auctionsPageFor(p: number, lu: number) {
      for (;;) {
        calls.push(`f${p}`);
        let r = (phase === 1 ? snap1 : snap2)[p];
        if (phase === 2 && p === 1 && stale) { stale = false; r = snap1[p]; } // first read stale
        if (r.lastUpdated >= lu) return r;
      }
    },
    flip() { phase = 2; },
    calls,
  };
  return c as unknown as HypixelClient & { flip(): void; calls: string[] };
}

function page(lu: number, pageNo: number, total: number, aucts: ReturnType<typeof auction>[]): AuctionsPage {
  return { success: true, page: pageNo, totalPages: total, totalAuctions: 0, lastUpdated: lu, auctions: aucts };
}

test('poller emits only auctions new to the snapshot and retries stale pages', async () => {
  const spec = { id: 'HOT_POTATO_BOOK', rarity: 'UNCOMMON', price: 90_000 };
  const a1 = auction(spec), a2 = auction(spec), a3 = auction(spec), a4 = auction(spec);
  // a5 is unseen but was created long before the previous snapshot: a resurfaced listing, not a new one.
  const a5 = auction({ ...spec, start: 1 });
  const lu1 = 1_000_000, lu2 = 1_060_000;
  const snap1 = [page(lu1, 0, 2, [a1, a2]), page(lu1, 1, 2, [a3])];
  const snap2 = [page(lu2, 0, 2, [a1, a4]), page(lu2, 1, 2, [a3, a5])];
  const client = fakeClient(snap1, snap2);
  const poller = new AuctionPoller(client, new LowestBinBook());
  const emitted: string[] = [];
  const cycles: number[] = [];
  poller.on('newAuctions', (list) => emitted.push(...list.map((e) => e.auction.uuid)));
  poller.on('cycle', (c) => cycles.push(c.lastUpdated));

  // Drive the private methods through run(): start, let the initial snapshot land, then flip and await detection.
  const run = poller.run();
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(poller.activeCount, 3);
    assert.deepEqual(emitted, [], 'initial snapshot is silent');
    client.flip();
    // lu1 is far in the past, so the poller is in its "Hypixel is late" mode probing every 500ms.
    await new Promise((r) => setTimeout(r, 1_200));
    assert.deepEqual(emitted, [a4.uuid], 'a5 must be suppressed by the start-time guard');
    assert.equal(poller.activeCount, 4, 'a2 gone, a4 and a5 added');
    assert.equal(cycles.at(-1), lu2);
    const f1 = client.calls.filter((c) => c === 'f1').length;
    assert.ok(f1 >= 2, `stale page should be re-fetched, got ${f1} fetches`);
  } finally {
    poller.stop();
    await Promise.race([run, new Promise((r) => setTimeout(r, 600))]);
  }
});
