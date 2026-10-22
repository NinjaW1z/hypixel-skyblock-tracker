import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { log } from './log.js';
import type { Flip, CreateAuctionRequest } from './types.js';

/**
 * Client for the backend's modsocket bridge (the Coflnet/BAF wire protocol): frames are
 * `{type, data: <JSON string>}`. Connects to `<modsocket url>?player=<ign>&version=…&SId=…`.
 * Emits: flip(Flip) · createAuction(CreateAuctionRequest) · getInventory() · chat(text) ·
 * execute(command) · connected() · disconnected()
 */
export class BridgeClient extends EventEmitter {
  private ws?: WebSocket;
  private want = false;
  private backoff = 1_000;
  private timer?: NodeJS.Timeout;
  private player = '';
  private uuid = '';
  private readonly sessionId = randomBytes(8).toString('hex');
  public connected = false;
  public readonly version = 'skyflip-bot/0.1';

  constructor(private readonly url: string) { super(); }

  /** Connect as this player (the Minecraft username; the backend resolves it to a UUID). */
  start(player: string, uuid = ''): void {
    this.player = player;
    this.uuid = uuid.replace(/-/g, '').toLowerCase();
    this.want = true;
    this.connect();
  }
  stop(): void { this.want = false; if (this.timer) clearTimeout(this.timer); this.ws?.close(); }

  send(type: string, data: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) }));
    return true;
  }
  uploadInventory(inventory: unknown): void { this.send('uploadInventory', JSON.stringify(inventory)); }
  uploadScoreboard(lines: string[]): void { this.send('uploadScoreboard', lines); }
  report(text: string): void { this.send('report', text); }
  clientError(message: string, data?: unknown): void { this.send('clientError', { message, data }); }
  logLine(text: string): void { this.send('log', text); }

  private connect(): void {
    if (!this.want) return;
    const u = new URL(this.url);
    u.searchParams.set('player', this.player);
    u.searchParams.set('version', this.version);
    u.searchParams.set('SId', this.sessionId);
    // Our extension: BAF cannot send this, so the backend falls back to Mojang when it is absent.
    if (this.uuid) u.searchParams.set('uuid', this.uuid);
    const ws = new WebSocket(u.toString(), { handshakeTimeout: 8_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff = 1_000;
      log.info(`bridge connected ${u.origin}${u.pathname.replace(/\/modsocket\/.+/, '/modsocket/<token>')} as ${this.player}`);
      this.emit('connected');
    });
    ws.on('message', (data) => {
      let m: { type?: string; data?: unknown };
      try { m = JSON.parse(String(data)); } catch { return; }
      this.handle(m);
    });
    ws.on('close', (code) => {
      if (this.connected) log.warn(`bridge disconnected (${code})`);
      this.connected = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });
    ws.on('error', (e) => { log.warn('bridge error:', (e as Error).message); });
    ws.on('unexpected-response', (_req, res) => { log.error(`bridge rejected the connection: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (check the token in feed.url / SKYFLIP_TOKEN)' : ''}`); });
  }

  private scheduleReconnect(): void {
    if (!this.want || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, this.backoff);
    this.backoff = Math.min(30_000, this.backoff * 2);
  }

  private handle(m: { type?: string; data?: unknown }): void {
    const data = decodeData(m.data);
    switch (m.type) {
      case 'flip': { const f = toFlip(data); if (f) this.emit('flip', f); else log.warn('bridge: unusable flip payload', typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)); return; }
      case 'createAuction': { const r = toCreateAuction(data); if (r) this.emit('createAuction', r); else log.warn('bridge: unusable createAuction payload'); return; }
      case 'getInventory': this.emit('getInventory'); return;
      case 'chatMessage': case 'writeToChat': {
        const items = Array.isArray(data) ? data : [data];
        for (const it of items) { const t = it && typeof it === 'object' ? (it as { text?: string }).text : String(it ?? ''); if (t) this.emit('chat', t); }
        return;
      }
      case 'execute': this.emit('execute', String(data ?? '')); return;
      case 'ping': this.send('pong', data ?? ''); return;
      case 'pong': return;
      default: log.debug('bridge: unhandled', m.type); return;
    }
  }
}

/** `data` is a JSON string, sometimes double-encoded, occasionally a bare object. */
export function decodeData(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  const t = data.trim();
  if (!t) return '';
  if (/^[[{"]/.test(t)) { try { const v = JSON.parse(t); return typeof v === 'string' ? decodeData(v) : v; } catch { return data; } }
  return data;
}

/** Coflnet/BAF flip payload (plus the extras our backend adds) → our Flip. */
export function toFlip(d: unknown): Flip | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const o = d as Record<string, unknown>;
  const auction = (o.auction && typeof o.auction === 'object' ? o.auction : {}) as Record<string, unknown>;
  const uuid = String(o.id ?? o.uuid ?? auction.uuid ?? '');
  const price = Number(o.startingBid ?? auction.startingBid ?? 0);
  const target = Number(o.target ?? 0);
  if (!uuid || !(price > 0)) return undefined;
  const now = Date.now();
  let purchaseAt: number | undefined;
  if (o.purchaseAt !== undefined && o.purchaseAt !== null) {
    const raw = o.purchaseAt;
    purchaseAt = typeof raw === 'number' ? (raw <= 1_000_000_000_000 ? raw * 1000 : raw) : Date.parse(String(raw));
    if (!Number.isFinite(purchaseAt)) purchaseAt = undefined;
  }
  const profit = typeof o.profit === 'number' ? o.profit : Math.max(0, target - price);
  const kindRaw = String(o.finder ?? o.kind ?? 'SNIPE').toUpperCase();
  const kind = kindRaw === 'MEDIAN' ? 'MEDIAN' : kindRaw === 'USER' ? 'USER' : 'SNIPE';
  const riskRaw = String(o.risk ?? 'HIGH').toUpperCase();
  const risk = riskRaw === 'LOW' ? 'LOW' : riskRaw === 'MEDIUM' ? 'MEDIUM' : 'HIGH';
  const itemId = String(o.itemId ?? auction.tag ?? '');
  return {
    uuid, kind, itemId, ruleId: itemId, itemName: String(o.itemName ?? auction.itemName ?? ''), rarity: '', count: Number(o.count ?? auction.count ?? 1) || 1,
    price, target, profit, profitPercent: typeof o.profitPerc === 'number' ? o.profitPerc / 100 : price > 0 ? profit / price : 0,
    lowestBin: typeof o.lowestBin === 'number' ? o.lowestBin : undefined, median: typeof o.median === 'number' ? o.median : undefined,
    priceSource: 'sales', salesPerDay: 0, keyTier: 0, risk, whitelisted: false, seller: '', latencyMs: 0,
    apiLastUpdated: typeof auction.start === 'number' ? auction.start : now, detectedAt: now, ageMs: typeof auction.start === 'number' ? now - auction.start : 0,
    end: typeof auction.end === 'number' ? auction.end : now + 3_600_000, command: `/viewauction ${uuid}`, purchaseAt,
  };
}

export function toCreateAuction(d: unknown): CreateAuctionRequest | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const o = d as Record<string, unknown>;
  const price = Number(o.price ?? o.startingBid);
  const slot = Number(o.slot ?? o.itemSlot);
  if (!(price > 0) || !Number.isInteger(slot)) return undefined;
  return { price: Math.floor(price), slot, duration: Number(o.duration ?? 48) || 48, itemName: String(o.itemName ?? ''), id: String(o.id ?? '') };
}
