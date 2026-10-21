import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auction } from './helpers.js';
import { evaluateAuction as evalRaw, toEntry, type DetectorContext } from '../flips/detector.js';
import type { Auction } from '../hypixel/types.js';
const evaluateAuction = (a: Auction, c: Parameters<typeof evalRaw>[1], lu: number, now?: number) => evalRaw(toEntry(a), c, lu, now);
import { SalesBook, LowestBinBook } from '../pricing/priceBook.js';
import { DEFAULT_SETTINGS, type Settings } from '../flips/settings.js';
import { decodeItemBytes } from '../nbt/decode.js';
import { itemBytesOf } from '../hypixel/types.js';
import { buildKeys } from '../pricing/key.js';

const spec = { id: 'HYPERION', rarity: 'LEGENDARY', lore: ['§6§lLEGENDARY'], extra: { modifier: 'heroic', upgrade_level: 10 } };

function ctx(settings: Partial<Settings> = {}): DetectorContext {
  return { sales: new SalesBook(7), lowestBin: new LowestBinBook(), settings: { ...DEFAULT_SETTINGS, ...settings, kinds: { ...DEFAULT_SETTINGS.kinds, ...(settings.kinds ?? {}) } } };
}
function keysOf(a: ReturnType<typeof auction>) { const it = decodeItemBytes(itemBytesOf(a)); return buildKeys(it, it.rarity ?? a.tier); }

test('snipe: new BIN well under the next lowest BIN', () => {
  const c = ctx();
  const market = [auction({ ...spec, price: 1_000_000_000 }), auction({ ...spec, price: 1_050_000_000 })];
  c.lowestBin.beginSnapshot();
  for (const m of market) c.lowestBin.add(keysOf(m), m.uuid, m.starting_bid);
  c.lowestBin.commit();
  const cheap = auction({ ...spec, price: 800_000_000 });
  const flip = evaluateAuction(cheap, c, Date.now() - 300)!;
  assert.ok(flip, 'expected a flip');
  assert.equal(flip.kind, 'SNIPE');
  assert.equal(flip.target, 1_000_000_000);
  assert.equal(flip.profit, 1_000_000_000 - 30_000_000 - 10_000_000 - 800_000_000);
  assert.equal(flip.command, `/viewauction ${cheap.uuid}`);
  assert.ok(flip.latencyMs >= 300);
  assert.equal(evaluateAuction(auction({ ...spec, price: 990_000_000 }), c, Date.now()), null, 'too little margin');
});

test('snipe: a single other listing is not enough without sold history', () => {
  const c = ctx();
  const only = auction({ ...spec, price: 9_000_000 });
  c.lowestBin.beginSnapshot(); c.lowestBin.add(keysOf(only), only.uuid, only.starting_bid); c.lowestBin.commit();
  assert.equal(evaluateAuction(auction({ ...spec, price: 200_000 }), c, Date.now()), null, 'one listing, no history');
  // With sold history that agrees, one other listing is fine.
  const now = Date.now();
  for (let i = 0; i < 5; i++) c.sales.record(keysOf(only), 8_500_000, now - i * 1000, true);
  const flip = evaluateAuction(auction({ ...spec, price: 4_000_000 }), c, now, now);
  assert.ok(flip);
  // And a no-history flip over 300% is dropped even with two listings.
  const c2 = ctx();
  const m1 = auction({ ...spec, price: 9_000_000 }), m2 = auction({ ...spec, price: 9_500_000 });
  c2.lowestBin.beginSnapshot(); c2.lowestBin.add(keysOf(m1), m1.uuid, m1.starting_bid); c2.lowestBin.add(keysOf(m2), m2.uuid, m2.starting_bid); c2.lowestBin.commit();
  assert.equal(evaluateAuction(auction({ ...spec, price: 200_000 }), c2, now, now), null, '4000% with no history');
  assert.ok(evaluateAuction(auction({ ...spec, price: 5_000_000 }), c2, now, now), '80% with two listings is fine');
});

test('median: price well under recent sales, undercutting an existing BIN', () => {
  const c = ctx();
  const now = Date.now();
  const sample = auction({ ...spec, price: 1 });
  const keys = keysOf(sample);
  for (let i = 0; i < 6; i++) c.sales.record(keys, 1_000_000_000 + i * 1_000_000, now - i * 3_600_000, true);
  // Existing cheaper BIN caps the target.
  c.lowestBin.beginSnapshot(); c.lowestBin.add(keys, 'other', 950_000_000); c.lowestBin.commit();
  const flip = evaluateAuction(auction({ ...spec, price: 700_000_000 }), c, now, now)!;
  assert.ok(flip);
  assert.equal(flip.target, 950_000_000);
  assert.equal(flip.median, 1_002_500_000);
  assert.equal(flip.lowestBin, 950_000_000);
  assert.ok(flip.salesPerDay > 0);
});

test('median flips need volume and respect maxKeyTier', () => {
  const c = ctx({ kinds: { SNIPE: false, MEDIAN: true }, maxKeyTier: 1 });
  const now = Date.now();
  const sample = auction({ ...spec, price: 1 });
  const keys = keysOf(sample);
  // volume only at tier 3 (id|rarity)
  for (let i = 0; i < 20; i++) c.sales.record(['z', 'z', 'z', keys[3], keys[4]], 1_000_000_000, now - i * 1000, true);
  assert.equal(evaluateAuction(auction({ ...spec, price: 500_000_000 }), c, now, now), null);
  c.settings.maxKeyTier = 4;
  const flip = evaluateAuction(auction({ ...spec, price: 500_000_000 }), c, now, now)!;
  assert.ok(flip);
  assert.equal(flip.keyTier, 3);
  assert.equal(flip.risk, 'HIGH');
});

test('filters: non-BIN, blacklist, whitelist, maxPrice, stacks', () => {
  const c = ctx({ blacklist: [{ item: 'HYPERION' }] });
  c.lowestBin.beginSnapshot();
  c.lowestBin.add(keysOf(auction({ ...spec, price: 1 })), 'o', 1_000_000_000);
  c.lowestBin.add(keysOf(auction({ ...spec, price: 1 })), 'o2', 1_050_000_000);
  c.lowestBin.commit();
  assert.equal(evaluateAuction(auction({ ...spec, price: 100 }), c, Date.now()), null, 'blacklisted');
  c.settings.blacklist = []; c.settings.whitelist = [{ item: 'TERMINATOR' }]; c.settings.whitelistOnly = true;
  assert.equal(evaluateAuction(auction({ ...spec, price: 100 }), c, Date.now()), null, 'not whitelisted');
  c.settings.whitelist = []; c.settings.whitelistOnly = false;
  assert.equal(evaluateAuction(auction({ ...spec, price: 100, bin: false }), c, Date.now()), null, 'not bin');
  c.settings.maxPrice = 50;
  assert.equal(evaluateAuction(auction({ ...spec, price: 100 }), c, Date.now()), null, 'over purse');
  c.settings.maxPrice = 0;

  // 16-stack priced per unit
  const c2 = ctx();
  const stackSpec = { id: 'RECOMBOBULATOR_3000', rarity: 'EPIC', lore: ['§5§lEPIC'] };
  c2.lowestBin.beginSnapshot();
  c2.lowestBin.add(keysOf(auction({ ...stackSpec, price: 1 })), 'o', 7_000_000);
  c2.lowestBin.add(keysOf(auction({ ...stackSpec, price: 1 })), 'o2', 7_100_000);
  c2.lowestBin.commit();
  const flip = evaluateAuction(auction({ ...stackSpec, count: 16, price: 80_000_000 }), c2, Date.now())!;
  assert.ok(flip);
  assert.equal(flip.count, 16);
  assert.equal(flip.target, 112_000_000);
});

test('rules: conditional blacklist, whitelist bypass, wildcard, external price source', () => {
  const now = Date.now();
  const market = (c: ReturnType<typeof ctx>) => {
    c.lowestBin.beginSnapshot();
    c.lowestBin.add(keysOf(auction({ ...spec, price: 1 })), 'o', 1_000_000_000);
    c.lowestBin.add(keysOf(auction({ ...spec, price: 1 })), 'o2', 1_050_000_000);
    c.lowestBin.commit();
  };
  // Blacklist only when risk is HIGH: a no-history 25% flip is MEDIUM risk, so it passes.
  const c = ctx({ blacklist: [{ item: 'HYP*', risk: 'HIGH' }] });
  market(c);
  assert.ok(evaluateAuction(auction({ ...spec, price: 750_000_000 }), c, now, now), 'medium risk passes a HIGH-only blacklist');
  c.settings.blacklist = [{ item: 'HYP*', minProfitPercent: 0.2 }];
  assert.equal(evaluateAuction(auction({ ...spec, price: 750_000_000 }), c, now, now), null, 'wildcard + percent condition drops it');

  // Whitelist bypasses minProfit.
  const w = ctx({ minProfit: 500_000_000, whitelist: [{ item: 'HYPERION', rarity: 'LEGENDARY' }] });
  market(w);
  const f = evaluateAuction(auction({ ...spec, price: 900_000_000 }), w, now, now)!;
  assert.ok(f && f.whitelisted, 'whitelisted flip ignores minProfit');
  assert.equal(f.ruleId, 'HYPERION');
  assert.ok(f.lore.length >= 1);

  // External price source fills in when there is no sales history.
  const e = ctx();
  e.lowestBin.beginSnapshot(); e.lowestBin.add(keysOf(auction({ ...spec, price: 1 })), 'o', 1_000_000_000); e.lowestBin.commit();
  assert.equal(evaluateAuction(auction({ ...spec, price: 600_000_000 }), e, now, now), null, 'single listing, no history');
  e.external = { lookup: () => ({ median: 1_100_000_000, volumePerDay: 12 }) };
  const g = evaluateAuction(auction({ ...spec, price: 600_000_000 }), e, now, now)!;
  assert.ok(g, 'coflnet median allows the single-listing snipe');
  assert.equal(g.priceSource, 'coflnet');
  assert.equal(g.median, Math.floor(1_100_000_000 * 0.85));
});
