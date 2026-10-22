import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from '../util/log.js';
import type { Flip } from '../flips/detector.js';
import type { SettingsStore, AutobuySettings } from '../flips/settings.js';
import { riskRank } from '../flips/settings.js';
import type { ProfitTracker, Purchase } from '../flips/tracker.js';
import type { MojangResolver } from '../hypixel/mojang.js';

/** The subset of the SQLite store the bridge needs (fakeable in tests). */
export interface BridgeStore {
  openPurchases(player: string, since: number): Purchase[];
  loadFlip(uuid: string): Flip | undefined;
}

export interface BridgeDeps {
  /** Shared secret; the bot connects to /modsocket/<token>. Required: without it the bridge refuses every connection. */
  token?: string;
  settings: SettingsStore;
  tracker: ProfitTracker;
  mojang: MojangResolver;
  store: BridgeStore;
  dataDir: string;
  /** Discord webhook sender; injectable. */
  webhook?: (text: string) => void;
  now?: () => number;
  /** Delay before the first getInventory after a purchase (ms). */
  inventoryDelayMs?: number;
  /** How often idle bots are nudged while the sell queue is non-empty (ms). */
  nudgeMs?: number;
}

export interface BotLogLine { ts: number; level: 'info' | 'warn' | 'error'; text: string }

/** One connected bot (BAF or our own `bot/`). */
export interface BotConn {
  ws: WebSocket;
  player: string;
  uuid?: string;
  version: string;
  sessionId: string;
  connectedAt: number;
  lastSeen: number;
  purse?: number;
  purseAt?: number;
  sidebar: string[];
  inventory?: InventoryItem[];
  inventoryAt?: number;
  flipsSent: number;
  /** Timestamps of purchases the tracker confirmed, for maxBuysPerHour. */
  buys: number[];
  lastCreateAuctionAt: number;
  lastInventoryRequestAt: number;
}

export interface InventoryItem { slot: number; name: string; count: number; skyblockId?: string; uuid?: string }

export interface PendingSale {
  auctionId: string;
  player: string;
  itemName: string;
  itemUuid?: string;
  cost: number;
  target?: number;
  listings: number;
  lastListedAt?: number;
  lastPrice?: number;
  note?: string;
}

export interface BridgeStatus {
  enabled: boolean;
  tokenConfigured: boolean;
  bots: {
    player: string; uuid?: string; version: string; connectedAt: number; lastSeen: number; purse?: number; purseAt?: number; location?: string;
    flipsSent: number; buysLastHour: number; inventory?: InventoryItem[]; inventoryAt?: number;
  }[];
  pending: PendingSale[];
  log: BotLogLine[];
  flipsForwarded: number;
  flipsRejected: number;
  lastRejectReason?: string;
}

const FLIP_KEEP = 5_000;

/**
 * Speaks the Coflnet "modsocket" protocol that BAF-style bots understand, so any such bot can be
 * pointed at this backend instead of Coflnet. Frames are `{type, data: <JSON string>}`.
 * Gates every flip through `settings.autobuy` (the purchase switch), then drives the sell loop:
 * purchase seen by the tracker → getInventory → createAuction for the item by its NBT uuid.
 */
export class ModSocketBridge extends EventEmitter {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly bots = new Map<WebSocket, BotConn>();
  private readonly pending = new Map<string, PendingSale>();
  private readonly sentFlips = new Set<string>();
  private readonly logLines: BotLogLine[] = [];
  private readonly sellFile: string;
  private nudgeTimer?: NodeJS.Timeout;
  private readonly now: () => number;
  public flipsForwarded = 0;
  public flipsRejected = 0;
  public lastRejectReason?: string;
  private lastWebhookAt = 0;

  constructor(private readonly d: BridgeDeps) {
    super();
    this.now = d.now ?? (() => Date.now());
    mkdirSync(d.dataDir, { recursive: true });
    this.sellFile = join(d.dataDir, 'autobuy-sell.json');
    this.loadSellState();
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req as IncomingMessage));
    d.tracker.on('purchase', (p: Purchase, flip?: Flip) => this.onPurchase(p, flip));
    d.tracker.on('sold', (p: Purchase) => this.onSold(p));
    this.nudgeTimer = setInterval(() => this.nudge(), d.nudgeMs ?? 45_000);
    this.nudgeTimer.unref();
  }

  close(): void {
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    for (const ws of this.bots.keys()) ws.close();
    this.wss.close();
  }

  // ---------------------------------------------------------------- connections

  /** Call from the HTTP server's 'upgrade' handler for paths under /modsocket. Returns true when handled. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pathname: string): boolean {
    if (!pathname.startsWith('/modsocket')) return false;
    const given = pathname.split('/')[2] ?? '';
    const want = this.d.token ?? '';
    const ok = want.length > 0 && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!ok) {
      this.log('warn', `modsocket connection refused from ${req.socket.remoteAddress ?? '?'} (${want ? 'bad token' : 'no SKYFLIP_TOKEN configured'})`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    return true;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const player = (url.searchParams.get('player') ?? '').trim();
    const bot: BotConn = {
      ws, player: player || 'unknown', version: url.searchParams.get('version') ?? '', sessionId: url.searchParams.get('SId') ?? '', connectedAt: this.now(), lastSeen: this.now(),
      sidebar: [], flipsSent: 0, buys: [], lastCreateAuctionAt: 0, lastInventoryRequestAt: 0,
    };
    // One connection per player: a reconnecting bot replaces its old socket.
    for (const [w, b] of this.bots) if (b.player.toLowerCase() === bot.player.toLowerCase()) { this.bots.delete(w); try { w.close(); } catch { /* ignore */ } }
    this.bots.set(ws, bot);
    this.log('info', `bot connected: ${bot.player} (version ${bot.version || '?'})`);
    this.send(bot, 'chatMessage', [{ text: `§6[SkyFlip] §7connected to the SkyFlip bridge as ${bot.player}; auto-buy is ${this.d.settings.current.autobuy.enabled ? '§aON' : '§cOFF'}` }]);
    ws.on('message', (data) => { bot.lastSeen = this.now(); this.onMessage(bot, String(data)); });
    ws.on('close', () => { this.bots.delete(ws); this.log('warn', `bot disconnected: ${bot.player}`); this.emit('status'); });
    ws.on('error', (e) => log.warn(`modsocket ${bot.player}:`, (e as Error).message));
    void this.resolvePlayer(bot, (url.searchParams.get('uuid') ?? '').replace(/-/g, '').toLowerCase());
    this.webhook(`🟢 bot **${bot.player}** connected to the bridge`);
    this.emit('status');
  }

  private async resolvePlayer(bot: BotConn, given?: string): Promise<void> {
    let uuid: string | undefined;
    if (given && /^[0-9a-f]{32}$/.test(given)) { uuid = given; this.d.mojang.remember(bot.player, given); }
    else uuid = await this.d.mojang.resolve(bot.player);
    if (!uuid) { this.log('warn', `could not resolve ${bot.player} to a UUID; purchases will not be tracked until Mojang answers`); return; }
    bot.uuid = uuid;
    this.d.tracker.track(uuid);
    // Anything bought earlier and still unsold joins the sell queue.
    for (const p of this.d.store.openPurchases(uuid, this.now() - 14 * 86_400_000)) this.queueSale(p, this.d.tracker.flipFor(p.auctionId) ?? this.d.store.loadFlip(p.auctionId));
    this.log('info', `${bot.player} is ${uuid}; ${this.pendingFor(uuid).length} unsold purchases queued for listing`);
    this.emit('status');
    if (this.pendingFor(uuid).length) this.requestInventory(bot);
  }

  // ---------------------------------------------------------------- incoming frames

  private onMessage(bot: BotConn, raw: string): void {
    let frame: { type?: string; data?: unknown };
    try { frame = JSON.parse(raw); } catch { return; }
    const data = decodeData(frame.data);
    switch (frame.type) {
      case 'uploadInventory': this.onInventory(bot, data); return;
      case 'uploadScoreboard': this.onScoreboard(bot, data); return;
      case 'report': this.log('warn', `${bot.player} report: ${short(data)}`); return;
      case 'clientError': {
        const o = (data && typeof data === 'object' ? data : { message: String(data) }) as { message?: string; data?: unknown };
        this.log('error', `${bot.player} error: ${o.message ?? short(data)}${o.data ? ` (${short(o.data)})` : ''}`);
        return;
      }
      case 'pong': return;
      case 'ping': this.send(bot, 'pong', data ?? ''); return;
      case 'log': case 'status': this.log('info', `${bot.player}: ${short(data)}`); return;
      default: log.debug(`modsocket ${bot.player}: unhandled ${frame.type}`); return;
    }
  }

  private onScoreboard(bot: BotConn, data: unknown): void {
    const lines = Array.isArray(data) ? data.map((l) => stripColor(String(typeof l === 'object' && l && 'text' in (l as object) ? (l as { text: string }).text : l))) : typeof data === 'string' ? data.split('\n').map(stripColor) : [];
    bot.sidebar = lines;
    for (const l of lines) {
      const m = l.match(/(?:Purse|Piggy):\s*([\d,]+)/i);
      if (m) { bot.purse = Number(m[1].replace(/,/g, '')); bot.purseAt = this.now(); }
    }
    this.emit('status');
  }

  private onInventory(bot: BotConn, data: unknown): void {
    const items = parseInventory(data);
    bot.inventory = items;
    bot.inventoryAt = this.now();
    log.debug(`modsocket ${bot.player}: inventory ${items.length} items`);
    this.emit('status');
    if (!bot.uuid || !this.d.settings.current.autobuy.autoSell) return;
    const ab = this.d.settings.current.autobuy;
    // One listing per upload: the bot needs the GUI for a while, then we ask again.
    for (const p of this.pendingFor(bot.uuid)) {
      if (!p.itemUuid) { if (!p.note) { p.note = 'item has no NBT uuid; list it by hand'; this.log('warn', `${p.itemName}: ${p.note}`); } continue; }
      const it = items.find((i) => i.uuid === p.itemUuid);
      if (!it) continue;
      if (p.lastListedAt && this.now() - p.lastListedAt < 90_000) continue; // just sent, the bot may still be at it
      const price = listPrice(p, ab);
      p.listings++; p.lastListedAt = this.now(); p.lastPrice = price; p.note = undefined;
      bot.lastCreateAuctionAt = this.now();
      this.send(bot, 'createAuction', { price, slot: it.slot, duration: ab.listHours, itemName: p.itemName, id: p.itemUuid });
      this.log('info', `${bot.player}: createAuction ${p.itemName} for ${fmt(price)} (cost ${fmt(p.cost)}, target ${p.target ? fmt(p.target) : '?'}, listing #${p.listings}, slot ${it.slot})`);
      this.saveSellState();
      return;
    }
  }

  // ---------------------------------------------------------------- flips → bots

  /** Gate a flip through the autobuy settings and the per-bot limits; forward to every eligible bot. */
  publishFlip(f: Flip): { sent: number; reason?: string } {
    const ab = this.d.settings.current.autobuy;
    const reject = (reason: string) => { this.flipsRejected++; this.lastRejectReason = reason; log.debug(`autobuy skip ${f.itemName}: ${reason}`); return { sent: 0, reason }; };
    if (!ab.enabled) return reject('autobuy off');
    if (this.bots.size === 0) return reject('no bot connected');
    if (this.sentFlips.has(f.uuid)) return reject('already sent');
    if (!f.whitelisted) {
      if (f.profit < ab.minProfit) return reject(`profit ${fmt(f.profit)} < ${fmt(ab.minProfit)}`);
      if (f.profitPercent < ab.minProfitPercent) return reject(`profit% ${(f.profitPercent * 100).toFixed(1)} < ${(ab.minProfitPercent * 100).toFixed(1)}`);
      if (riskRank(f.risk) > riskRank(ab.maxRisk)) return reject(`risk ${f.risk} > ${ab.maxRisk}`);
    } else if (f.profit <= 0) return reject('whitelisted but no profit');
    if (ab.maxPrice > 0 && f.price > ab.maxPrice) return reject(`price ${fmt(f.price)} > max ${fmt(ab.maxPrice)}`);
    if (ab.requireHistory && f.priceSource === 'none') return reject('no price reference');
    if (ab.requireOwnHistory && f.priceSource !== 'sales') return reject(`reference is ${f.priceSource}`);
    const start = f.apiLastUpdated - f.ageMs;
    if (this.now() - start > ab.maxAgeMs) return reject(`auction is ${Math.round((this.now() - start) / 1000)}s old`);
    const purchaseAt = Math.max(this.now(), start + ab.bedDelayMs);
    const payload = {
      id: f.uuid, uuid: f.uuid, startingBid: f.price, purchaseAt: new Date(purchaseAt).toISOString(), itemName: f.itemName, target: f.target,
      finder: f.kind, profit: f.profit, profitPerc: Math.round(f.profitPercent * 1000) / 10, risk: f.risk, itemId: f.itemId, count: f.count, median: f.median, lowestBin: f.lowestBin,
      auction: { uuid: f.uuid, startingBid: f.price, tag: f.itemId, itemName: f.itemName, start, end: f.end, bin: true, count: f.count },
    };
    let sent = 0;
    const hourAgo = this.now() - 3_600_000;
    for (const bot of this.bots.values()) {
      if (bot.ws.readyState !== WebSocket.OPEN) continue;
      if (ab.purseReserve > 0 && bot.purse !== undefined && bot.purse - f.price < ab.purseReserve) { log.debug(`autobuy skip ${f.itemName} for ${bot.player}: purse ${fmt(bot.purse)} would drop under the reserve`); continue; }
      if (bot.purse !== undefined && bot.purse < f.price) { log.debug(`autobuy skip ${f.itemName} for ${bot.player}: purse ${fmt(bot.purse)} < price`); continue; }
      if (ab.maxBuysPerHour > 0 && bot.buys.filter((t) => t > hourAgo).length >= ab.maxBuysPerHour) continue;
      this.send(bot, 'flip', payload);
      bot.flipsSent++;
      sent++;
    }
    if (sent === 0) return reject('no eligible bot (purse / hourly cap)');
    this.sentFlips.add(f.uuid);
    if (this.sentFlips.size > FLIP_KEEP) { for (const k of this.sentFlips) { this.sentFlips.delete(k); if (this.sentFlips.size <= FLIP_KEEP / 2) break; } }
    this.flipsForwarded++;
    this.log('info', `flip → ${sent} bot${sent === 1 ? '' : 's'}: ${f.itemName} ${fmt(f.price)} → ${fmt(f.target)} (+${fmt(f.profit)}, ${f.kind}/${f.risk}${purchaseAt > this.now() + 500 ? `, bed ${Math.round((purchaseAt - this.now()) / 1000)}s` : ''})`);
    this.emit('status');
    return { sent };
  }

  // ---------------------------------------------------------------- sell loop

  private onPurchase(p: Purchase, flip?: Flip): void {
    const bot = this.botFor(p.player);
    if (!bot) return;
    bot.buys.push(this.now());
    bot.buys = bot.buys.filter((t) => t > this.now() - 3_600_000);
    if (bot.purse !== undefined) bot.purse -= p.price;
    this.log('info', `${bot.player} BOUGHT ${p.itemName} for ${fmt(p.price)}${flip ? ` (predicted +${fmt(flip.profit)})` : ''}`);
    this.webhook(`🛒 **${bot.player}** bought **${p.itemName}** for ${fmt(p.price)}${flip ? ` (predicted +${fmt(flip.profit)})` : ''}`);
    if (!this.d.settings.current.autobuy.autoSell) return;
    this.queueSale(p, flip);
    const t = setTimeout(() => this.requestInventory(bot), this.d.inventoryDelayMs ?? 12_000);
    t.unref();
    this.emit('status');
  }

  private onSold(p: Purchase): void {
    const s = this.pending.get(p.auctionId);
    this.pending.delete(p.auctionId);
    this.saveSellState();
    const bot = this.botFor(p.player);
    const got = p.soldPrice ?? 0;
    const net = got - fee(got) - p.price;
    this.log('info', `${bot?.player ?? p.player} SOLD ${p.itemName} for ${fmt(got)} (paid ${fmt(p.price)}, ${net >= 0 ? '+' : ''}${fmt(net)} after fees)${s ? ` after ${s.listings} listing${s.listings === 1 ? '' : 's'}` : ''}`);
    this.webhook(`💰 **${bot?.player ?? p.player}** sold **${p.itemName}** for ${fmt(got)} (paid ${fmt(p.price)}, ${net >= 0 ? '+' : ''}${fmt(net)} after fees)`);
    this.emit('status');
  }

  private queueSale(p: Purchase, flip?: Flip): void {
    if (this.pending.has(p.auctionId)) { const s = this.pending.get(p.auctionId)!; if (!s.itemUuid && p.itemUuid) s.itemUuid = p.itemUuid; return; }
    this.pending.set(p.auctionId, { auctionId: p.auctionId, player: p.player, itemName: p.itemName, itemUuid: p.itemUuid, cost: p.price, target: flip?.target, listings: 0 });
    this.saveSellState();
  }

  private pendingFor(uuid: string): PendingSale[] { return [...this.pending.values()].filter((s) => s.player === uuid); }

  private requestInventory(bot: BotConn): void {
    if (bot.ws.readyState !== WebSocket.OPEN) return;
    bot.lastInventoryRequestAt = this.now();
    this.send(bot, 'getInventory', '');
  }

  /** While something waits to be listed, poke idle bots for their inventory. */
  private nudge(): void {
    if (!this.d.settings.current.autobuy.autoSell) return;
    for (const bot of this.bots.values()) {
      if (!bot.uuid || this.pendingFor(bot.uuid).length === 0) continue;
      if (this.now() - bot.lastCreateAuctionAt < 60_000) continue;
      this.requestInventory(bot);
    }
  }

  private loadSellState(): void {
    if (!existsSync(this.sellFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.sellFile, 'utf8')) as PendingSale[];
      for (const s of raw) if (s && s.auctionId) this.pending.set(s.auctionId, s);
    } catch { /* start empty */ }
  }
  private saveSellState(): void {
    try {
      const tmp = this.sellFile + '.tmp';
      writeFileSync(tmp, JSON.stringify([...this.pending.values()], null, 2));
      renameSync(tmp, this.sellFile);
    } catch (e) { log.warn('cannot save sell state:', (e as Error).message); }
  }

  // ---------------------------------------------------------------- helpers

  private botFor(playerUuid: string): BotConn | undefined {
    const u = playerUuid.replace(/-/g, '').toLowerCase();
    for (const b of this.bots.values()) if (b.uuid === u) return b;
    return undefined;
  }

  private send(bot: BotConn, type: string, data: unknown): void {
    if (bot.ws.readyState !== WebSocket.OPEN) return;
    bot.ws.send(JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) }));
  }

  /**
   * Second phase: bazaar order flips in the shape the Rust BAF reads (`bazaarFlip`:
   * itemName, itemTag, amount, pricePerUnit, isBuyOrder). Sent only when autobuy.enabled and
   * autobuy.bazaarOrders are both on. Our own bot logs and ignores these.
   */
  publishBazaar(flips: { productId: string; name?: string; buyOrderPrice: number; sellOrderPrice: number; unitsPerHour: number; profitPerHour: number }[]): number {
    const ab = this.d.settings.current.autobuy;
    if (!ab.enabled || !ab.bazaarOrders || this.bots.size === 0) return 0;
    let sent = 0;
    for (const f of flips.slice(0, 3)) {
      const amount = Math.max(1, Math.min(Math.floor(f.unitsPerHour), Math.floor(ab.bazaarMaxOrder / Math.max(1, f.buyOrderPrice))));
      const payload = { itemName: f.name ?? f.productId, itemTag: f.productId, amount, pricePerUnit: f.buyOrderPrice, totalPrice: amount * f.buyOrderPrice, isBuyOrder: true, sellPricePerUnit: f.sellOrderPrice, profitPerHour: f.profitPerHour };
      for (const bot of this.bots.values()) { this.send(bot, 'bazaarFlip', payload); sent++; }
    }
    if (sent) log.debug(`autobuy: ${sent} bazaar order messages sent`);
    return sent;
  }

  /** Text to every bot's console/chat (BAF prints `chatMessage`). */
  broadcastChat(text: string): void {
    for (const b of this.bots.values()) this.send(b, 'chatMessage', [{ text }]);
  }

  /** Forward a console command to every bot (BAF `execute`). */
  execute(command: string): void {
    for (const b of this.bots.values()) this.send(b, 'execute', command);
  }

  get connectedBots(): BotConn[] { return [...this.bots.values()]; }

  private log(level: BotLogLine['level'], text: string): void {
    this.logLines.push({ ts: this.now(), level, text });
    if (this.logLines.length > 200) this.logLines.shift();
    (level === 'error' ? log.error : level === 'warn' ? log.warn : log.info)(`autobuy: ${text}`);
    this.emit('log', this.logLines[this.logLines.length - 1]);
  }

  private webhook(text: string): void {
    const url = this.d.settings.current.autobuy.webhookUrl;
    if (!url || !this.d.webhook) return;
    this.lastWebhookAt = this.now();
    try { this.d.webhook(text); } catch { /* ignore */ }
  }

  status(): BridgeStatus {
    const hourAgo = this.now() - 3_600_000;
    return {
      enabled: this.d.settings.current.autobuy.enabled,
      tokenConfigured: Boolean(this.d.token),
      bots: [...this.bots.values()].map((b) => ({
        player: b.player, uuid: b.uuid, version: b.version, connectedAt: b.connectedAt, lastSeen: b.lastSeen, purse: b.purse, purseAt: b.purseAt,
        location: b.sidebar.find((l) => l.includes('⏣'))?.replace(/.*⏣\s*/, ''), flipsSent: b.flipsSent, buysLastHour: b.buys.filter((t) => t > hourAgo).length,
        inventory: b.inventory, inventoryAt: b.inventoryAt,
      })),
      pending: [...this.pending.values()],
      log: this.logLines.slice(-100),
      flipsForwarded: this.flipsForwarded,
      flipsRejected: this.flipsRejected,
      lastRejectReason: this.lastRejectReason,
    };
  }
}

/** Resale price for a queued item: target × (1 − undercut), 5 % lower per earlier listing, never below cost × 1.03. */
export function listPrice(p: { cost: number; target?: number; listings: number }, ab: Pick<AutobuySettings, 'undercutPercent'>): number {
  const floor = Math.ceil(p.cost * 1.03);
  if (!p.target || p.target <= 0) return floor;
  const drop = Math.pow(0.95, p.listings);
  return Math.max(floor, Math.floor(p.target * (1 - ab.undercutPercent) * drop));
}

/** `data` arrives as a JSON string (BAF), sometimes double-encoded, sometimes a plain object. */
export function decodeData(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  const t = data.trim();
  if (!t) return '';
  if (/^[[{"]/.test(t)) {
    try { const v = JSON.parse(t); return typeof v === 'string' ? decodeData(v) : v; } catch { return data; }
  }
  return data;
}

/** mineflayer's `JSON.stringify(bot.inventory)` (or a bare slots array) → flat items with NBT ids. */
export function parseInventory(data: unknown): InventoryItem[] {
  const d = decodeData(data) as { slots?: unknown[] } | unknown[] | undefined;
  const slots = Array.isArray(d) ? d : Array.isArray(d?.slots) ? d!.slots : [];
  const out: InventoryItem[] = [];
  slots.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const it = s as { slot?: number; name?: string; displayName?: string; count?: number; nbt?: unknown };
    const extra = nbtGet(nbtGet(it.nbt, 'ExtraAttributes'), '');
    const uuid = nbtValue(nbtGet(extra, 'uuid'));
    const id = nbtValue(nbtGet(extra, 'id'));
    const display = nbtGet(it.nbt, 'display');
    let name = nbtValue(nbtGet(display, 'Name'));
    if (typeof name === 'string' && /^[{"[]/.test(name)) { try { name = textOf(JSON.parse(name)); } catch { /* keep */ } }
    out.push({ slot: typeof it.slot === 'number' ? it.slot : i, name: stripColor(typeof name === 'string' && name ? name : (it.displayName ?? it.name ?? '')), count: it.count ?? 1, skyblockId: typeof id === 'string' ? id : undefined, uuid: typeof uuid === 'string' ? uuid : undefined });
  });
  return out;
}

function nbtValue(v: unknown): unknown { return v && typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v; }
function nbtGet(obj: unknown, key: string): unknown {
  const o = nbtValue(obj);
  if (!o || typeof o !== 'object') return undefined;
  return key ? (o as Record<string, unknown>)[key] : o;
}
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (v && typeof v === 'object') { const o = v as { text?: string; extra?: unknown[] }; return (o.text ?? '') + (o.extra ? o.extra.map(textOf).join('') : ''); }
  return '';
}
function stripColor(s: string): string { return s.replace(/§[0-9a-fk-or]/gi, ''); }
function short(v: unknown): string { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 300 ? s.slice(0, 300) + '…' : s; }
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + 'm';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return String(Math.round(n));
}
function fee(price: number): number {
  const rate = price >= 100_000_000 ? 0.03 : price >= 10_000_000 ? 0.02 : 0.01;
  return Math.floor(price * rate) + (price > 1_000_000 ? Math.floor(price * 0.01) : 0);
}
