/**
 * A tiny 1.8 Minecraft server that imitates the parts of Hypixel SkyBlock the bot touches:
 * the SkyBlock sidebar (purse), /viewauction → "BIN Auction View" → "Confirm Purchase",
 * /ah → View Bids / Manage Auctions, claiming, and the Create BIN Auction flow with the sign.
 * Used by the integration test and for poking at the bot by hand:
 *
 *   node dist/scripts/mock-hypixel-server.js            (listens on 25565)
 *   MC_HOST=127.0.0.1 MC_AUTH=offline BOT_MODE=live MC_ACCOUNT=Tester npm start
 */
import mc from 'minecraft-protocol';
import type { Server, ServerClient } from 'minecraft-protocol';

export interface MockAuction { id: string; name: string; price: number; sold?: boolean; seller?: string }
export interface MockListing { name: string; price: number; bin: boolean; duration: string; status: 'active' | 'sold' | 'expired'; soldFor?: number }
export interface MockState {
  purse: number;
  auctions: Map<string, MockAuction>;
  /** Bought items waiting to be claimed from "Your Bids". */
  claimable: string[];
  /** Player inventory (hotbar first), by display name. */
  inventory: (string | null)[];
  /** Our own auctions. */
  listings: MockListing[];
  log: string[];
  clicks: { title: string; slot: number }[];
  /** Simulate another player buying the auction between the view and the confirm. */
  snipeOnConfirm?: boolean;
}

interface Slot { blockId: number; itemCount?: number; itemDamage?: number; nbtData?: unknown }

const EMPTY: Slot = { blockId: -1 };
function item(name: string, lore: string[] = [], blockId = 266, extra: Record<string, string> = {}): Slot {
  const ea: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) ea[k] = { type: 'string', value: v };
  return {
    blockId, itemCount: 1, itemDamage: 0,
    nbtData: { type: 'compound', name: '', value: { display: { type: 'compound', value: { Name: { type: 'string', value: name }, Lore: { type: 'list', value: { type: 'string', value: lore } } } }, ExtraAttributes: { type: 'compound', value: ea } } },
  };
}
const pane = (): Slot => item(' ', [], 160);

export function startMockHypixel(port = 25565, init: Partial<MockState> = {}): { server: Server; state: MockState; close: () => void } {
  const state: MockState = { purse: 10_000_000, auctions: new Map(), claimable: [], inventory: new Array(36).fill(null), listings: [], log: [], clicks: [], ...init };
  const server = mc.createServer({ 'online-mode': false, version: '1.8', port, host: '127.0.0.1', motd: 'mock hypixel', maxPlayers: 5, keepAlive: true, hideErrors: true } as Parameters<typeof mc.createServer>[0]);
  server.on('login', (client) => session(client, state));
  return { server, state, close: () => server.close() };
}

function session(client: ServerClient, state: MockState): void {
  let windowId = 0;
  let current: { id: number; kind: string; title: string; items: Slot[]; data?: Record<string, unknown> } | undefined;
  let signPending: ((text: string) => void) | undefined;
  const log = (s: string) => { state.log.push(s); };

  const chat = (text: string) => client.write('chat', { message: JSON.stringify({ text }), position: 0 });
  const purseLine = () => `Purse: ${state.purse.toLocaleString('en-US')}`;
  let lastPurseLine = '';
  const scoreboard = () => {
    if (lastPurseLine) client.write('scoreboard_score', { itemName: lastPurseLine, action: 1, scoreName: 'SBScoreboard', value: 0 });
    lastPurseLine = purseLine();
    client.write('scoreboard_score', { itemName: lastPurseLine, action: 0, scoreName: 'SBScoreboard', value: 3 });
  };
  const inventoryItems = (): Slot[] => {
    const slots: Slot[] = new Array(45).fill(EMPTY);
    // hotbar is inventory[0..8] → window-0 slots 36..44, main is inventory[9..35] → slots 9..35
    for (let i = 0; i < 36; i++) { const n = state.inventory[i]; if (n) slots[i < 9 ? 36 + i : i] = item(n, ['§7An item'], 276, { id: n.toUpperCase().replace(/ /g, '_'), uuid: `uuid-${n}` }); }
    return slots;
  };
  const sendInventory = () => client.write('window_items', { windowId: 0, items: inventoryItems() });
  const open = (kind: string, title: string, container: Slot[], data?: Record<string, unknown>) => {
    windowId = (windowId % 100) + 1;
    const items = [...container];
    while (items.length < 54) items.push(EMPTY);
    const full = [...items, ...inventoryItems().slice(9)];
    current = { id: windowId, kind, title, items: full, data };
    client.write('open_window', { windowId, inventoryType: 'minecraft:chest', windowTitle: JSON.stringify({ text: title }), slotCount: 54 });
    // Hypixel fills menus a moment after opening them.
    client.write('window_items', { windowId, items: full.map((s, i) => (i < 54 && s.blockId !== -1 ? pane() : s)) });
    setTimeout(() => { if (current?.id === windowId) client.write('window_items', { windowId, items: full }); }, 60);
  };
  const close = () => { if (current) { client.write('close_window', { windowId: current.id }); current = undefined; } };
  const addToInventory = (name: string) => { const i = state.inventory.indexOf(null); if (i >= 0) state.inventory[i] = name; };

  client.write('login', { entityId: 1, gameMode: 0, dimension: 0, difficulty: 0, maxPlayers: 1, levelType: 'default', reducedDebugInfo: false });
  client.write('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0 });
  client.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
  sendInventory();
  client.write('scoreboard_objective', { name: 'SBScoreboard', action: 0, displayText: '§e§lSKYBLOCK', type: 'integer' });
  client.write('scoreboard_display_objective', { position: 1, name: 'SBScoreboard' });
  client.write('scoreboard_score', { itemName: ' ⏣ Your Island', action: 0, scoreName: 'SBScoreboard', value: 5 });
  scoreboard();

  // ---- menus ----
  const binView = (a: MockAuction) => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    c[13] = item(`§6${a.name}`, ['§7A fine item'], 276, { id: a.name.toUpperCase().replace(/ /g, '_') });
    c[29] = item('§6Bid history', []);
    c[31] = a.sold ? item('§cSold!', ['§7This auction was sold']) : item('§6Buy Item Right Now', [`§7Price: §6${a.price.toLocaleString('en-US')} coins`]);
    c[49] = item('§aGo Back', [], 262);
    open('binView', 'BIN Auction View', c, { auction: a.id });
  };
  const confirmPurchase = (a: MockAuction) => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    c[11] = item('§aConfirm', [`§7Purchase for §6${a.price.toLocaleString('en-US')} coins`], 159);
    c[15] = item('§cCancel', [], 159);
    open('confirm', 'Confirm Purchase', c, { auction: a.id });
  };
  const ahMenu = () => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    c[11] = item('§6Auctions Browser', ['§7Find items']);
    c[13] = item('§aView Bids', [`§7You have §e${state.claimable.length} §7items to claim`]);
    c[15] = item('§aManage Auctions', [`§7Active: §e${state.listings.length}`]);
    open('ah', 'Auction House', c);
  };
  const bidsMenu = () => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    state.claimable.forEach((n, i) => { c[10 + i] = item(`§6${n}`, ['§7Status: §aBought', '§eClick to claim!'], 276); });
    if (state.claimable.length >= 2) c[49] = item('§aClaim All', ['§7Claim everything'], 54);
    c[48] = item('§aGo Back', [], 262);
    open('bids', 'Your Bids', c);
  };
  const manageMenu = () => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    state.listings.forEach((l, i) => {
      const lore = l.status === 'sold' ? [`§7Sold for §6${(l.soldFor ?? l.price).toLocaleString('en-US')} coins`, '§eClick to claim coins!']
        : l.status === 'expired' ? ['§cExpired!', '§eClick to claim item!'] : [`§7Price: §6${l.price.toLocaleString('en-US')} coins`, '§7Ends in §e47h'];
      c[10 + i] = item(`§6${l.name}`, lore, 276);
    });
    c[24] = item('§aCreate Auction', ['§7Sell an item'], 54);
    if (state.listings.some((l) => l.status !== 'active')) c[22] = item('§aClaim All', ['§7Collect all'], 54);
    open('manage', 'Manage Auctions', c);
  };
  interface Draft { itemName?: string; bin: boolean; price: number; duration: string; invIndex?: number }
  const createMenu = (d: Draft) => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    c[13] = d.itemName ? item(`§6${d.itemName}`, ['§7Your item'], 276) : item('§eClick an item in your inventory!', ['§7Choose something to sell'], 160);
    c[29] = item(d.bin ? '§aCreate BIN Auction' : '§aCreate Auction', ['§7Start it']);
    c[31] = item(d.bin ? '§aItem Price' : '§aStarting Bid', [`§7Item price: §6${d.price.toLocaleString('en-US')} coins`, '§eClick to edit!']);
    c[33] = item('§aDuration', [`§7Currently: §e${d.duration}`, '§eClick to edit!'], 347);
    c[48] = item(`§aAuction Type: §e${d.bin ? 'BIN' : 'Auction'}`, ['§eClick to switch!'], 340);
    c[49] = item('§aGo Back', [], 262);
    open('create', d.bin ? 'Create BIN Auction' : 'Create Auction', c, { draft: d });
  };
  const durationMenu = (d: Draft) => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    ['6 Hours', '12 Hours', '24 Hours', '48 Hours'].forEach((n, i) => { c[11 + i] = item(`§a${n}`, ['§7Pick'], 347); });
    c[49] = item('§aGo Back', [], 262);
    open('duration', 'Auction Duration', c, { draft: d });
  };
  const confirmListing = (d: Draft) => {
    const c: Slot[] = new Array(54).fill(EMPTY);
    c[11] = item('§aConfirm', [`§7List for §6${d.price.toLocaleString('en-US')} coins`], 159);
    c[15] = item('§cCancel', [], 159);
    open('confirmListing', 'Confirm', c, { draft: d });
  };

  // ---- client packets ----
  client.on('chat', ({ message }: { message: string }) => {
    log(`chat: ${message}`);
    const m = message.match(/^\/viewauction (\S+)/);
    if (m) {
      const a = state.auctions.get(m[1]);
      if (!a) { chat("§cThis auction wasn't found!"); return; }
      binView(a);
      return;
    }
    if (message === '/ah') { ahMenu(); return; }
    if (/^\/(is|play|lobby|l)\b/.test(message)) { chat('§7Warping...'); return; }
    chat(`§cUnknown command: ${message}`);
  });

  client.on('close_window', () => { current = undefined; });

  client.on('update_sign', (p: { text1: string }) => {
    let text = p.text1;
    try { text = JSON.parse(text); } catch { /* plain */ }
    if (typeof text === 'object' && text && 'text' in (text as object)) text = (text as { text: string }).text;
    log(`sign: ${text}`);
    signPending?.(String(text));
    signPending = undefined;
  });

  client.on('window_click', (p: { windowId: number; slot: number; action: number }) => {
    client.write('transaction', { windowId: p.windowId, action: p.action, accepted: true });
    if (!current || current.id !== p.windowId) return;
    const w = current;
    state.clicks.push({ title: w.title, slot: p.slot });
    log(`click ${w.title} ${p.slot}`);
    switch (w.kind) {
      case 'binView': {
        const a = state.auctions.get(w.data!.auction as string)!;
        if (p.slot === 31 && !a.sold) confirmPurchase(a);
        else if (p.slot === 31 && a.sold && a.seller === 'me') { /* collect */ }
        else if (p.slot === 49) ahMenu();
        return;
      }
      case 'confirm': {
        const a = state.auctions.get(w.data!.auction as string)!;
        if (p.slot !== 11) { close(); return; }
        if (state.snipeOnConfirm || a.sold) { chat('§cThis auction has already been sold!'); close(); return; }
        if (state.purse < a.price) { chat("§cYou don't have enough coins to purchase this!"); close(); return; }
        a.sold = true;
        state.purse -= a.price;
        state.claimable.push(a.name);
        close();
        scoreboard();
        chat(`§aYou purchased §6${a.name} §afor §6${a.price.toLocaleString('en-US')} coins§a!`);
        return;
      }
      case 'ah':
        if (p.slot === 13) bidsMenu();
        else if (p.slot === 15) manageMenu();
        return;
      case 'bids': {
        if (p.slot === 49 && state.claimable.length >= 2) {
          for (const n of state.claimable) addToInventory(n);
          chat(`§aYou claimed ${state.claimable.length} auctions!`);
          state.claimable = [];
          sendInventory();
          close();
          return;
        }
        const idx = p.slot - 10;
        const n = state.claimable[idx];
        if (n === undefined) return;
        const c: Slot[] = new Array(54).fill(EMPTY);
        c[13] = item(`§6${n}`, ['§7Status: §aBought'], 276);
        c[31] = item('§aCollect Auction', ['§7Take the item'], 41);
        open('collect', 'BIN Auction View', c, { index: idx });
        return;
      }
      case 'collect': {
        if (p.slot !== 31) return;
        const idx = w.data!.index as number;
        const [n] = state.claimable.splice(idx, 1);
        addToInventory(n);
        sendInventory();
        close();
        chat(`§aYou claimed §6${n} §afrom the auction house!`);
        return;
      }
      case 'manage': {
        if (p.slot === 24) { createMenu({ bin: false, price: 0, duration: '6 Hours' }); return; }
        if (p.slot === 22) {
          let coins = 0;
          for (const l of state.listings) { if (l.status === 'sold') coins += l.soldFor ?? l.price; else if (l.status === 'expired') addToInventory(l.name); }
          state.listings = state.listings.filter((l) => l.status === 'active');
          state.purse += coins;
          scoreboard(); sendInventory(); close();
          chat(`§aClaimed §6${coins.toLocaleString('en-US')} coins§a!`);
          return;
        }
        return;
      }
      case 'create': {
        const d = w.data!.draft as Draft;
        if (p.slot >= 54) {
          const invIndex = p.slot - 54 + 9; // window slot → inventory index (main 9..35, hotbar 36..44)
          const idx = invIndex >= 36 ? invIndex - 36 : invIndex;
          const n = state.inventory[idx];
          if (!n) return;
          d.itemName = n; d.invIndex = idx;
          // Hypixel updates in place: the item moves to slot 13.
          w.items[13] = item(`§6${n}`, ['§7Your item'], 276);
          w.items[p.slot] = EMPTY;
          client.write('set_slot', { windowId: w.id, slot: 13, item: w.items[13] });
          client.write('set_slot', { windowId: w.id, slot: p.slot, item: EMPTY });
          return;
        }
        if (p.slot === 48) { d.bin = !d.bin; createMenu(d); return; }
        if (p.slot === 31) {
          client.write('open_sign_entity', { location: { x: 0, y: 70, z: 0 } });
          current = undefined;
          signPending = (text) => { const n = Number(text.replace(/[^0-9.]/g, '')); if (Number.isFinite(n) && n > 0) d.price = Math.floor(n); createMenu(d); };
          return;
        }
        if (p.slot === 33) { durationMenu(d); return; }
        if (p.slot === 29) { if (!d.itemName || d.price <= 0) { chat('§cSet an item and a price first!'); return; } confirmListing(d); return; }
        if (p.slot === 49) { manageMenu(); return; }
        return;
      }
      case 'duration': {
        const d = w.data!.draft as Draft;
        const names = ['6 Hours', '12 Hours', '24 Hours', '48 Hours'];
        if (p.slot >= 11 && p.slot < 15) d.duration = names[p.slot - 11];
        createMenu(d);
        return;
      }
      case 'confirmListing': {
        const d = w.data!.draft as Draft;
        if (p.slot !== 11) { createMenu(d); return; }
        if (d.invIndex !== undefined) state.inventory[d.invIndex] = null;
        state.listings.push({ name: d.itemName!, price: d.price, bin: d.bin, duration: d.duration, status: 'active' });
        sendInventory();
        close();
        chat(`§a${d.bin ? 'BIN ' : ''}Auction started for §6${d.itemName}§a!`);
        return;
      }
      default: return;
    }
  });
}

if (process.argv[1] && /mock-hypixel-server\.js$/.test(process.argv[1])) {
  const port = Number(process.env.PORT ?? 25565);
  const { state } = startMockHypixel(port);
  state.auctions.set('demo1', { id: 'demo1', name: 'Hyperion', price: 1_000_000 });
  state.auctions.set('demo2', { id: 'demo2', name: 'Aspect of the End', price: 50_000 });
  console.log(`mock hypixel on 127.0.0.1:${port} · purse ${state.purse} · auctions demo1 (1,000,000), demo2 (50,000)`);
}
