/**
 * Local stand-in for api.hypixel.net so the full pipeline can run offline.
 *
 * It models what matters for the flipper: a paginated snapshot that refreshes on a clock,
 * a short window of stale pages right after refresh, an auctions_ended feed, gzip bodies,
 * realistic item_bytes, and a trickle of deliberately under-priced listings.
 *
 *   MOCK_PORT=3999 MOCK_INTERVAL_MS=15000 MOCK_AUCTIONS=12000 node dist/scripts/mock-hypixel.js
 *   HYPIXEL_BASE=http://127.0.0.1:3999/v2 npm start
 */
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { encodeItemBytes } from '../nbt/encode.js';

const PORT = Number(process.env.MOCK_PORT ?? 3999);
const INTERVAL = Number(process.env.MOCK_INTERVAL_MS ?? 15_000);
const TOTAL = Number(process.env.MOCK_AUCTIONS ?? 12_000);
const PAGE = 1000;
const CHURN = 0.03;          // fraction replaced per refresh
const UNDERPRICED = 0.04;    // fraction of new listings that are flips
const STALE_WINDOW_MS = 400; // pages other than 0 lag page 0 by this much
const SEED_SALES = process.env.MOCK_SEED_SALES !== '0';

interface Catalog { id: string; name: string; rarity: string; base: number; variants?: () => Record<string, unknown> }
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const CATALOG: Catalog[] = [
  { id: 'HYPERION', name: '§6Heroic Hyperion §6✪✪✪✪✪', rarity: 'LEGENDARY', base: 950_000_000, variants: () => ({ modifier: 'heroic', upgrade_level: pick([5, 7, 10]), enchantments: { ultimate_wise: 5, sharpness: pick([6, 7]), critical: pick([6, 7]) }, rarity_upgrades: pick([0, 1]), hot_potato_count: 15 }) },
  { id: 'TERMINATOR', name: '§6Terminator', rarity: 'LEGENDARY', base: 500_000_000, variants: () => ({ modifier: pick(['precise', 'spiritual']), enchantments: { power: pick([6, 7]), overload: pick([3, 5]), ultimate_soul_eater: pick([1, 3, 5]) } }) },
  { id: 'ASPECT_OF_THE_VOID', name: '§5Aspect of the Void', rarity: 'EPIC', base: 5_000_000, variants: () => ({ ethermerge: pick([0, 1]), tuned_transmission: pick([0, 4]) }) },
  { id: 'NECRON_CHESTPLATE', name: '§6Necron\'s Chestplate', rarity: 'LEGENDARY', base: 120_000_000, variants: () => ({ modifier: 'ancient', upgrade_level: pick([5, 7, 10]), rarity_upgrades: 1, enchantments: { ultimate_legion: pick([3, 5]), growth: pick([6, 7]), protection: pick([6, 7]) } }) },
  { id: 'PET', name: '§7[Lvl 100] §6Ender Dragon', rarity: 'LEGENDARY', base: 400_000_000, variants: () => ({ petInfo: JSON.stringify({ type: 'ENDER_DRAGON', tier: 'LEGENDARY', exp: pick([25_000_000, 15_000_000, 30_000_000]), active: false, candyUsed: 0 }) }) },
  { id: 'PET', name: '§7[Lvl 80] §5Griffin', rarity: 'EPIC', base: 2_500_000, variants: () => ({ petInfo: JSON.stringify({ type: 'GRIFFIN', tier: 'EPIC', exp: pick([2_000_000, 8_000_000, 18_608_500]), active: false, candyUsed: 0 }) }) },
  { id: 'ENCHANTED_BOOK', name: '§fEnchanted Book', rarity: 'EPIC', base: 60_000_000, variants: () => ({ enchantments: { ultimate_legion: 5 } }) },
  { id: 'ENCHANTED_BOOK', name: '§fEnchanted Book', rarity: 'RARE', base: 3_000_000, variants: () => ({ enchantments: { ultimate_wise: 1 } }) },
  { id: 'DIVAN_DRILL', name: '§6Divan\'s Drill', rarity: 'LEGENDARY', base: 800_000_000, variants: () => ({ drill_part_engine: pick(['AMBER_POLISHED_DRILL_ENGINE', 'SAPPHIRE_POLISHED_DRILL_ENGINE']), drill_part_fuel_tank: 'PERFECTLY_CUT_FUEL_TANK' }) },
  { id: 'MIDAS_SWORD', name: '§6Midas\' Sword', rarity: 'LEGENDARY', base: 55_000_000, variants: () => ({ winning_bid: pick([50_000_000, 25_000_000, 10_000_000]), modifier: 'fabled' }) },
  { id: 'WARDEN_HELMET', name: '§6Warden Helmet', rarity: 'LEGENDARY', base: 85_000_000, variants: () => ({ modifier: 'ancient', rarity_upgrades: 1, upgrade_level: pick([5, 6, 8]) }) },
  { id: 'GIANTS_SWORD', name: '§6Giant\'s Sword', rarity: 'LEGENDARY', base: 300_000_000, variants: () => ({ upgrade_level: pick([0, 5]), enchantments: { ultimate_one_for_all: pick([0, 1]) } }) },
  { id: 'INFERNAL_CRIMSON_CHESTPLATE', name: '§6Infernal Crimson Chestplate', rarity: 'LEGENDARY', base: 90_000_000, variants: () => ({ attributes: { magic_find: pick([3, 5, 7]), veteran: pick([3, 5, 8]) }, modifier: 'ancient' }) },
  { id: 'RECOMBOBULATOR_3000', name: '§5Recombobulator 3000', rarity: 'EPIC', base: 7_000_000 },
  { id: 'HOT_POTATO_BOOK', name: '§aHot Potato Book', rarity: 'UNCOMMON', base: 85_000 },
  { id: 'OVERFLUX_POWER_ORB', name: '§5Overflux Power Orb', rarity: 'EPIC', base: 7_500_000 },
  { id: 'JUJU_SHORTBOW', name: '§5Juju Shortbow', rarity: 'EPIC', base: 15_000_000, variants: () => ({ modifier: pick(['precise', 'spiritual']), upgrade_level: pick([0, 5]), enchantments: { power: 6, overload: pick([1, 5]) } }) },
  { id: 'WITHER_CLOAK', name: '§6Wither Cloak Sword', rarity: 'LEGENDARY', base: 2_000_000 },
  { id: 'DAEDALUS_AXE', name: '§6Daedalus Axe', rarity: 'LEGENDARY', base: 20_000_000, variants: () => ({ modifier: 'fabled' }) },
  { id: 'GOLDEN_DRAGON_EGG', name: '§6Golden Dragon Egg', rarity: 'LEGENDARY', base: 600_000_000 },
];

interface MockAuction {
  uuid: string; auctioneer: string; profile_id: string; start: number; end: number; item_name: string; item_lore: string;
  category: string; tier: string; starting_bid: number; item_bytes: string; claimed: boolean; highest_bid_amount: number; bin: true; bids: never[];
  _fair: number;
}

function variantValue(c: Catalog, extra: Record<string, unknown>): number {
  // Give modifiers a price impact so comparables at different tiers diverge like the real AH.
  let v = c.base;
  if (extra.rarity_upgrades) v *= 1.08;
  if (typeof extra.upgrade_level === 'number') v *= 1 + 0.06 * extra.upgrade_level;
  if (extra.ethermerge) v *= 2.2;
  if (extra.tuned_transmission) v *= 1.3;
  const ench = (extra.enchantments ?? {}) as Record<string, number>;
  for (const [n, l] of Object.entries(ench)) {
    if (n === 'ultimate_one_for_all' && l) v *= 1.4;
    else if (n.startsWith('ultimate_')) v *= 1 + 0.05 * l;
    else if (l >= 7) v *= 1.15;
  }
  if (typeof extra.winning_bid === 'number') v = c.base * (extra.winning_bid >= 50_000_000 ? 1 : 0.3);
  if (typeof extra.petInfo === 'string') {
    const exp = (JSON.parse(extra.petInfo) as { exp: number }).exp;
    v *= exp >= 25_000_000 ? 1 : exp >= 10_000_000 ? 0.45 : 0.25;
  }
  const attrs = (extra.attributes ?? {}) as Record<string, number>;
  for (const l of Object.values(attrs)) v *= 1 + 0.12 * (l - 3);
  return Math.round(v);
}

let seq = 0;
const uuid = () => (Date.now().toString(16) + (seq++).toString(16).padStart(6, '0') + Math.random().toString(16).slice(2)).slice(0, 32);

function makeAuction(now: number, underpriced: boolean): MockAuction {
  const c = pick(CATALOG);
  const extra = c.variants ? c.variants() : {};
  const fair = variantValue(c, extra);
  const noise = rnd(0.93, 1.12);
  const price = Math.round(fair * (underpriced ? rnd(0.5, 0.8) : noise));
  const lore = ['§7A fine item.', '', `§6§l${c.rarity}`];
  return {
    uuid: uuid(), auctioneer: uuid(), profile_id: uuid(), start: now - Math.floor(rnd(0, 50_000)), end: now + 86_400_000,
    item_name: c.name.replace(/§[0-9a-fk-or]/g, ''), item_lore: lore.join('\n'), category: 'weapon', tier: c.rarity,
    starting_bid: price, item_bytes: encodeItemBytes({ id: c.id, name: c.name, rarity: c.rarity, lore, extra }),
    claimed: false, highest_bid_amount: 0, bin: true, bids: [], _fair: fair,
  };
}

let lastUpdated = Date.now();
let prevLastUpdated = 0;
let pages: Omit<MockAuction, '_fair'>[][] = [];
let prevPages: typeof pages = [];
let auctions: MockAuction[] = [];
let ended: { auction_id: string; seller: string; seller_profile: string; buyer: string; buyer_profile: string; timestamp: number; price: number; bin: boolean; item_bytes: string }[] = [];
let endedLastUpdated = 0;

function paginate(list: MockAuction[]): typeof pages {
  const out: typeof pages = [];
  for (let i = 0; i < list.length; i += PAGE) out.push(list.slice(i, i + PAGE).map(({ _fair, ...a }) => a));
  return out.length ? out : [[]];
}

function refresh(): void {
  const now = Date.now();
  // Sell a slice of the market at (roughly) fair value and replace it.
  const sold = Math.floor(auctions.length * CHURN);
  const soldList: MockAuction[] = [];
  for (let i = 0; i < sold; i++) soldList.push(auctions.splice(Math.floor(Math.random() * auctions.length), 1)[0]);
  ended = soldList.map((a) => ({
    auction_id: a.uuid, seller: a.auctioneer, seller_profile: a.profile_id, buyer: uuid(), buyer_profile: uuid(),
    timestamp: now - Math.floor(rnd(0, INTERVAL)), price: Math.round(a._fair * rnd(0.95, 1.05)), bin: true, item_bytes: a.item_bytes,
  }));
  for (let i = 0; i < sold; i++) auctions.push(makeAuction(now, Math.random() < UNDERPRICED));
  for (let i = auctions.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [auctions[i], auctions[j]] = [auctions[j], auctions[i]]; }
  prevPages = pages; prevLastUpdated = lastUpdated;
  pages = paginate(auctions); lastUpdated = now; endedLastUpdated = now;
  console.log(`[mock] refresh ${now}: ${auctions.length} auctions, ${pages.length} pages, ${sold} sold/new`);
}

// ---- bootstrap ----
const t0 = Date.now();
for (let i = 0; i < TOTAL; i++) auctions.push(makeAuction(t0, Math.random() < UNDERPRICED * 0.3));
pages = paginate(auctions); prevPages = pages; prevLastUpdated = lastUpdated = t0; endedLastUpdated = t0;
if (SEED_SALES) {
  // Pretend a week of sales already happened so MEDIAN flips can be exercised immediately.
  for (let i = 0; i < 4000; i++) {
    const a = makeAuction(t0, false);
    ended.push({ auction_id: a.uuid, seller: a.auctioneer, seller_profile: a.profile_id, buyer: uuid(), buyer_profile: uuid(),
      timestamp: t0 - Math.floor(rnd(0, 6 * 86_400_000)), price: Math.round(a._fair * rnd(0.95, 1.05)), bin: true, item_bytes: a.item_bytes });
  }
}
setInterval(refresh, INTERVAL);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const gz = /gzip/.test(String(req.headers['accept-encoding'] ?? ''));
  const send = (obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj));
    if (gz) { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(gzipSync(body)); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); }
  };
  if (url.pathname === '/v2/skyblock/auctions') {
    const page = Number(url.searchParams.get('page') ?? 0);
    // Emulate the CDN: pages other than 0 keep serving the previous snapshot briefly.
    const stale = page !== 0 && Date.now() - lastUpdated < STALE_WINDOW_MS && prevPages.length;
    const src = stale ? prevPages : pages;
    const lu = stale ? prevLastUpdated : lastUpdated;
    if (page < 0 || page >= src.length) { res.writeHead(404); res.end(JSON.stringify({ success: false, cause: 'Page not found' })); return; }
    send({ success: true, page, totalPages: src.length, totalAuctions: src.reduce((n, p) => n + p.length, 0), lastUpdated: lu, auctions: src[page] });
    return;
  }
  if (url.pathname === '/v2/skyblock/auctions_ended') {
    send({ success: true, lastUpdated: endedLastUpdated, auctions: ended });
    return;
  }
  res.writeHead(404); res.end('{"success":false}');
}).listen(PORT, () => console.log(`[mock] hypixel API on http://127.0.0.1:${PORT}/v2  refresh every ${INTERVAL}ms, ${TOTAL} auctions`));
