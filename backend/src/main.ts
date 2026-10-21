// Decompression and DB work run on the libuv threadpool; give it room before anything uses it.
process.env.UV_THREADPOOL_SIZE ??= '16';

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config } from './config.js';
import { log } from './util/log.js';
import { HypixelClient } from './hypixel/client.js';
import { ItemNames } from './hypixel/items.js';
import { SalesBook, LowestBinBook } from './pricing/priceBook.js';
import { CoflnetPrices, coflnetTag } from './pricing/coflnet.js';
import { Store } from './storage/db.js';
import { SettingsStore } from './flips/settings.js';
import { ProfitTracker } from './flips/tracker.js';
import { AuctionPoller } from './ingest/auctionPoller.js';
import { EndedPoller } from './ingest/endedPoller.js';
import { evaluateAuction, type ExternalPriceLookup } from './flips/detector.js';
import { BazaarService } from './bazaar/bazaarService.js';
import { FeedServer } from './server/server.js';
import type { ItemData } from './nbt/decode.js';

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = resolve(join(here, '..', 'web'));
  const dataDir = resolve(config.dataDir);
  const token = process.env.SKYFLIP_TOKEN?.trim() || undefined;

  log.info(`skyflip starting · api=${config.hypixelBase} · data=${dataDir}`);
  const store = new Store(dataDir);
  const settings = new SettingsStore(dataDir);
  const sales = new SalesBook(config.historyDays);
  const lowestBin = new LowestBinBook();
  const tracker = new ProfitTracker(store);

  // Warm the sales book from disk so medians work immediately after a restart.
  const since = Date.now() - config.historyDays * 86_400_000;
  const pruned = store.pruneSales(since);
  const loaded = store.loadSales(since);
  for (const s of loaded) sales.record(s.keys, s.unitPrice, s.ts, s.bin);
  log.info(`loaded ${loaded.length} sales (${sales.size} keys) from disk, pruned ${pruned}; tracking ${tracker.trackedPlayers.length} players`);

  const client = new HypixelClient();
  const names = new ItemNames(client);
  names.start();

  // Coflnet public API fills reference-price gaps until our own history is deep enough.
  const coflnet = config.coflnet ? new CoflnetPrices({ requestsPerMinute: config.coflnetRpm }) : undefined;
  coflnet?.start();
  const external: ExternalPriceLookup | undefined = coflnet && {
    lookup(item: ItemData, rarity: string) {
      const tag = coflnetTag(item.id, item);
      if (!tag) return undefined;
      const hit = coflnet.get(tag, rarity);
      if (!hit) { coflnet.request(tag, rarity); return undefined; }
      if (hit.median <= 0 || hit.volume <= 0) return undefined;
      return { median: hit.median, volumePerDay: hit.volume };
    },
  };

  const bazaar = new BazaarService(client);
  const server = new FeedServer({ port: config.port, webDir, settings, tracker, bazaar, names, token });
  const auctions = new AuctionPoller(client, lowestBin);
  const ended = new EndedPoller(client, sales, store);
  ended.on('sale', (ev) => tracker.onSale(ev));

  let flipsThisCycle = 0;
  const emitted = new Set<string>();

  auctions.on('newAuctions', (list, lastUpdated) => {
    const ctx = { sales, lowestBin, settings: settings.current, external };
    const now = Date.now();
    for (const e of list) {
      if (emitted.has(e.auction.uuid)) continue;
      const flip = evaluateAuction(e, ctx, lastUpdated, now);
      if (!flip) continue;
      emitted.add(e.auction.uuid);
      flipsThisCycle++;
      server.status.flipsTotal++;
      tracker.rememberFlip(flip);
      server.publishFlip(flip);
      store.saveFlip(flip);
      log.info(`FLIP ${flip.kind} ${flip.itemName} ${fmt(flip.price)} -> ${fmt(flip.target)} (+${fmt(flip.profit)}, ${(flip.profitPercent * 100).toFixed(0)}%) [${flip.risk}/${flip.priceSource}] ${flip.command} lag ${flip.latencyMs}ms`);
    }
  });

  auctions.on('cycle', async (c) => {
    Object.assign(server.status, {
      apiLastUpdated: c.lastUpdated, detectLagMs: c.detectLagMs, fetchMs: c.fetchMs, intervalMs: c.intervalMs, pages: c.pages,
      totalAuctions: c.totalAuctions, newAuctions: c.newAuctions, flipsThisCycle, salesTracked: sales.total, salesKeys: sales.size,
      lowestBinKeys: lowestBin.size, requests: client.requests, bytesIn: client.bytesIn, coflnet: coflnet?.stats ?? server.status.coflnet,
    });
    server.status.cycles++;
    log.info(`cycle ${c.lastUpdated}: ${c.pages} pages, ${c.totalAuctions} auctions, ${c.newAuctions} new, ${flipsThisCycle} flips, detect lag ${c.detectLagMs}ms, fetch ${c.fetchMs}ms, interval ${Math.round(c.intervalMs / 1000)}s, clients ${server.clients}${coflnet ? `, coflnet cache ${coflnet.stats.cacheSize} queue ${coflnet.stats.queueSize}` : ''}`);
    flipsThisCycle = 0;
    if (emitted.size > 50_000) emitted.clear();
    server.publishStatus();
    // The ended feed refreshes on the same clock; pull it right after the snapshot lands.
    try { await ended.pollOnce(); } catch (e) { log.warn('ended poll failed:', (e as Error).message); }
  });

  auctions.on('error', (e) => log.warn('auction poller:', (e as Error).message ?? e));
  bazaar.on('error', (e: unknown) => log.warn('bazaar:', (e as Error).message ?? e));
  bazaar.on('update', (flips: unknown[]) => log.debug(`bazaar: ${flips.length} flips`));

  const shutdown = async () => {
    log.info('shutting down');
    auctions.stop();
    ended.stop();
    bazaar.stop();
    coflnet?.stop();
    await client.close().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  void bazaar.run(config.bazaarIntervalMs);
  await auctions.run();
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'm';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return String(n);
}

main().catch((e) => { log.error(e); process.exit(1); });
