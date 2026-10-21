import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from '../util/log.js';
import type { Flip } from '../flips/detector.js';
import type { SettingsStore, Settings, Rule } from '../flips/settings.js';
import type { BazaarService, BazaarFlip } from '../bazaar/bazaarService.js';
import type { ProfitTracker, Purchase } from '../flips/tracker.js';
import type { ItemNames } from '../hypixel/items.js';
import { parseCoflnetExport, applyImport } from '../flips/coflnetImport.js';
import { readdirSync } from 'node:fs';
import type { ModSocketBridge } from './modsocket.js';
import type { BotService } from '../bot/service.js';
import type { PacingScheduler } from '../bot/pacing.js';

export interface Status {
  startedAt: number;
  apiLastUpdated: number;
  detectLagMs: number;
  fetchMs: number;
  intervalMs: number;
  pages: number;
  totalAuctions: number;
  newAuctions: number;
  flipsThisCycle: number;
  flipsTotal: number;
  salesTracked: number;
  salesKeys: number;
  lowestBinKeys: number;
  requests: number;
  bytesIn: number;
  cycles: number;
  bazaarLastUpdated: number;
  bazaarFlips: number;
  coflnet: { requests: number; errors: number; cacheSize: number; queueSize: number; rateLimited: number };
  trackedPlayers: number;
  clients: number;
  /** Purchase switch. */
  autobuy: boolean;
  /** Connected auto-buy bots. */
  bots: number;
  /** Login switch + systemd state, e.g. "on/active". */
  botService: string;
}

export interface ServerDeps {
  port: number;
  webDir: string;
  settings: SettingsStore;
  tracker: ProfitTracker;
  bazaar?: BazaarService;
  names?: ItemNames;
  /** Shared secret. When set, REST (except static files) and the WebSocket require it. */
  token?: string;
  /** Directory of starter rule packs (*.json). */
  packsDir?: string;
  /** Auto-buy: the modsocket bridge bots connect to, the login switch and the pacing scheduler. */
  bridge?: ModSocketBridge;
  botService?: BotService;
  pacing?: PacingScheduler;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

interface ClientMsg {
  type: string;
  settings?: Partial<Settings>;
  uuid?: string;
  name?: string;
  key?: string;
  value?: string;
  list?: 'blacklist' | 'whitelist';
  action?: string;
  text?: string;
  role?: string;
  rule?: Rule;
  item?: string;
  limit?: number;
  days?: number;
  mode?: 'merge' | 'replace';
  data?: unknown;
  pack?: string;
}

/**
 * One HTTP server does three jobs: static web UI, a small REST API, and the WebSocket feed
 * consumed by both the web UI and the Minecraft mod.
 */
export class FeedServer {
  private readonly wss: WebSocketServer;
  private readonly recent: Flip[] = [];
  private readonly playerOf = new Map<WebSocket, string>();
  public status: Status;

  constructor(private readonly d: ServerDeps) {
    this.status = {
      startedAt: Date.now(), apiLastUpdated: 0, detectLagMs: 0, fetchMs: 0, intervalMs: 0, pages: 0, totalAuctions: 0, newAuctions: 0,
      flipsThisCycle: 0, flipsTotal: 0, salesTracked: 0, salesKeys: 0, lowestBinKeys: 0, requests: 0, bytesIn: 0, cycles: 0,
      bazaarLastUpdated: 0, bazaarFlips: 0, coflnet: { requests: 0, errors: 0, cacheSize: 0, queueSize: 0, rateLimited: 0 }, trackedPlayers: 0, clients: 0,
      autobuy: d.settings.current.autobuy.enabled, bots: 0, botService: 'off',
    };
    const server = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (d.bridge && d.bridge.handleUpgrade(req, socket, head, url.pathname)) return;
      if (url.pathname !== '/ws') { socket.destroy(); return; }
      if (!this.authorized(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    d.settings.onChange((s) => this.broadcast({ type: 'settings', settings: s }));
    d.bazaar?.on('update', () => {
      this.status.bazaarLastUpdated = d.bazaar!.lastUpdated;
      this.status.bazaarFlips = d.bazaar!.all().length;
      this.broadcast({ type: 'bazaar', flips: this.bazaarTop(30) });
    });
    d.bridge?.on('status', () => this.pushBot());
    d.bridge?.on('log', () => this.pushBot());
    d.botService?.on('change', () => this.pushBot());
    d.settings.onChange(() => this.pushBot());
    d.tracker.on('purchase', (p: Purchase, flip?: Flip) => this.sendToPlayer(p.player, { type: 'purchase', purchase: p, flip }));
    d.tracker.on('sold', (p: Purchase) => this.sendToPlayer(p.player, { type: 'sold', purchase: p }));
    server.listen(d.port, () => log.info(`web UI + feed on http://localhost:${d.port}  (ws://localhost:${d.port}/ws)${d.token ? ' · token required' : ' · no token (set SKYFLIP_TOKEN before exposing this)'}`));
  }

  get clients(): number { return this.wss.clients.size; }

  publishFlip(f: Flip): void {
    this.recent.push(f);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    this.broadcast({ type: 'flip', flip: f });
  }

  publishStatus(): void {
    this.status.clients = this.clients;
    this.status.trackedPlayers = this.d.tracker.trackedPlayers.length;
    this.status.autobuy = this.d.settings.current.autobuy.enabled;
    this.status.bots = this.d.bridge?.connectedBots.length ?? 0;
    const svc = this.d.botService?.status();
    this.status.botService = svc ? `${svc.desired}/${svc.active}${svc.pausedBy ? ' (paused by pacing)' : ''}` : 'n/a';
    this.broadcast({ type: 'status', status: this.status });
  }

  /** Everything the Bot tab and the mod's /skyflip bot need in one object. */
  botStatus(): unknown {
    return {
      autobuy: this.d.settings.current.autobuy,
      pacingSettings: this.d.settings.current.pacing,
      bridge: this.d.bridge?.status(),
      service: this.d.botService?.status(),
      pacing: this.d.pacing?.status(),
      ts: Date.now(),
    };
  }
  private botPushTimer?: NodeJS.Timeout;
  private pushBot(): void {
    if (this.botPushTimer) return;
    this.botPushTimer = setTimeout(() => { this.botPushTimer = undefined; this.broadcast({ type: 'bot', bot: this.botStatus() }); }, 300);
  }

  /** Bot switches shared by the WebSocket and REST paths. */
  private async botControl(action: string, text?: string): Promise<{ ok: boolean; text: string }> {
    switch (action) {
      case 'login-on': case 'start': {
        if (!this.d.botService) return { ok: false, text: 'bot service control is not configured' };
        const s = await this.d.botService.setDesired(true);
        return { ok: !s.lastError, text: s.lastError ?? `bot login switch ON (service ${s.active})` };
      }
      case 'login-off': case 'stop': {
        if (!this.d.botService) return { ok: false, text: 'bot service control is not configured' };
        const s = await this.d.botService.setDesired(false);
        return { ok: !s.lastError, text: s.lastError ?? `bot login switch OFF (service ${s.active})` };
      }
      case 'autobuy-on': this.d.settings.update({ autobuy: { ...this.d.settings.current.autobuy, enabled: true } }); return { ok: true, text: 'auto-buy ON: flips are forwarded to connected bots' };
      case 'autobuy-off': this.d.settings.update({ autobuy: { ...this.d.settings.current.autobuy, enabled: false } }); return { ok: true, text: 'auto-buy OFF: nothing is forwarded' };
      case 'inventory': this.d.bridge?.execute('inventory'); for (const b of this.d.bridge?.connectedBots ?? []) b.ws.send(JSON.stringify({ type: 'getInventory', data: '' })); return { ok: true, text: 'inventory requested' };
      case 'execute': if (!text) return { ok: false, text: 'nothing to run' }; this.d.bridge?.execute(text); return { ok: true, text: `sent to bots: ${text}` };
      case 'chat': if (!text) return { ok: false, text: 'nothing to say' }; this.d.bridge?.broadcastChat(text); return { ok: true, text: 'sent' };
      case 'status': default: return { ok: true, text: 'status' };
    }
  }

  // ---- auth ----

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.d.token) return true;
    const header = req.headers.authorization ?? '';
    const candidate = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '');
    const a = Buffer.from(candidate), b = Buffer.from(this.d.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- websocket ----

  private onConnection(ws: WebSocket): void {
    ws.send(JSON.stringify({
      type: 'hello', settings: this.d.settings.current, status: this.status, flips: this.recent.slice(-50), bazaar: this.bazaarTop(30),
      tokenRequired: Boolean(this.d.token), packs: this.listPacks(), bot: this.botStatus(),
    }));
    ws.on('message', (data) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(data)) as ClientMsg; } catch { return; }
      try { this.handleMessage(ws, msg); } catch (e) { this.send(ws, { type: 'msg', level: 'error', text: (e as Error).message }); }
    });
    ws.on('close', () => this.playerOf.delete(ws));
  }

  private handleMessage(ws: WebSocket, m: ClientMsg): void {
    const s = this.d.settings;
    switch (m.type) {
      case 'identify': {
        if (m.uuid) { this.d.tracker.track(m.uuid); this.playerOf.set(ws, m.uuid.replace(/-/g, '').toLowerCase()); }
        this.send(ws, { type: 'identified', uuid: m.uuid, name: m.name, tracked: this.d.tracker.trackedPlayers.length });
        return;
      }
      case 'settings': if (m.settings) s.update(m.settings); return;
      case 'set': {
        if (!m.key) return;
        const err = s.set(m.key, m.value ?? '');
        this.send(ws, err ? { type: 'msg', level: 'error', text: err } : { type: 'msg', text: `${m.key} set` });
        return;
      }
      case 'rule': {
        const list = m.list === 'whitelist' ? 'whitelist' : 'blacklist';
        if (m.action === 'add' && m.rule) { s.addRule(list, m.rule); this.send(ws, { type: 'msg', text: `${list} rule added` }); }
        else if (m.action === 'remove' && m.item) { s.removeRule(list, m.item.toUpperCase()); this.send(ws, { type: 'msg', text: `${list} rules for ${m.item.toUpperCase()} removed` }); }
        else this.send(ws, { type: 'rules', list, rules: s.current[list] });
        return;
      }
      case 'bazaar': this.send(ws, { type: 'bazaar', flips: this.bazaarTop(m.limit ?? 15), requested: true }); return;
      case 'profit': {
        const uuid = m.uuid ?? this.playerOf.get(ws);
        if (!uuid) { this.send(ws, { type: 'msg', level: 'error', text: 'identify first' }); return; }
        this.send(ws, { type: 'profit', summary: this.d.tracker.summary(uuid, (m.days ?? 7) * 86_400_000) });
        return;
      }
      case 'import': {
        const report = parseCoflnetExport(m.data);
        if (report.imported > 0 || Object.keys(report.settingsPatch).length) s.update(applyImport(report, s.current, m.mode === 'replace' ? 'replace' : 'merge'));
        this.send(ws, { type: 'import', report });
        return;
      }
      case 'pack': {
        const r = this.loadPack(m.pack ?? '', m.mode === 'replace' ? 'replace' : 'merge');
        this.send(ws, r.ok ? { type: 'msg', text: r.text } : { type: 'msg', level: 'error', text: r.text });
        return;
      }
      case 'ping': this.send(ws, { type: 'pong', t: Date.now() }); return;
      case 'bot': this.send(ws, { type: 'bot', bot: this.botStatus(), requested: true }); return;
      case 'botControl': {
        void this.botControl(m.action ?? 'status', m.text).then((r) => {
          this.send(ws, { type: 'msg', level: r.ok ? 'info' : 'error', text: r.text });
          this.send(ws, { type: 'bot', bot: this.botStatus(), requested: m.action === 'status' });
          this.pushBot();
        });
        return;
      }
      default: return;
    }
  }

  /** Starter packs: {name, description, settings?, blacklist, whitelist, bazaar?} files in packsDir. */
  listPacks(): { id: string; name: string; description: string; rules: number }[] {
    if (!this.d.packsDir) return [];
    try {
      return readdirSync(this.d.packsDir).filter((f) => f.endsWith('.json')).map((f) => {
        const p = JSON.parse(readFileSync(join(this.d.packsDir!, f), 'utf8')) as { name?: string; description?: string; blacklist?: unknown[]; whitelist?: unknown[] };
        return { id: f.replace(/\.json$/, ''), name: p.name ?? f, description: p.description ?? '', rules: (p.blacklist?.length ?? 0) + (p.whitelist?.length ?? 0) };
      });
    } catch { return []; }
  }

  loadPack(id: string, mode: 'merge' | 'replace'): { ok: boolean; text: string } {
    if (!this.d.packsDir || !/^[a-z0-9_-]+$/i.test(id)) return { ok: false, text: 'unknown pack' };
    let p: { name?: string; settings?: Partial<Settings>; blacklist?: Rule[]; whitelist?: Rule[]; bazaar?: Settings['bazaar'] };
    try { p = JSON.parse(readFileSync(join(this.d.packsDir, `${id}.json`), 'utf8')); } catch { return { ok: false, text: 'unknown pack' }; }
    const cur = this.d.settings.current;
    const dedupe = (rules: Rule[]) => { const seen = new Set<string>(); return rules.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; }); };
    this.d.settings.update({
      ...(p.settings ?? {}),
      ...(p.bazaar ? { bazaar: p.bazaar } : {}),
      blacklist: mode === 'replace' ? (p.blacklist ?? []) : dedupe([...cur.blacklist, ...(p.blacklist ?? [])]),
      whitelist: mode === 'replace' ? (p.whitelist ?? []) : dedupe([...cur.whitelist, ...(p.whitelist ?? [])]),
    });
    return { ok: true, text: `${p.name ?? id} pack ${mode === 'replace' ? 'loaded (lists replaced)' : 'merged'}` };
  }

  private bazaarTop(limit: number): BazaarFlip[] {
    if (!this.d.bazaar) return [];
    const f = this.d.settings.current.bazaar;
    const flips = this.d.bazaar.top({ minProfitPerHour: f.minProfitPerHour, minProfitPercent: f.minProfitPercent, maxPrice: f.maxPrice || undefined, minVolumeWeek: f.minVolumeWeek, risk: f.maxRisk, limit });
    if (!this.d.names) return flips;
    return flips.map((x) => {
      const n = this.d.names!.name(x.productId);
      return n ? { ...x, name: n, command: `/bz ${n}` } : x;
    });
  }

  private send(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  private sendToPlayer(player: string, obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const [ws, p] of this.playerOf) if (p === player && ws.readyState === WebSocket.OPEN) ws.send(s);
    // The web UI is not tied to a player; let it see purchases too.
    for (const c of this.wss.clients) if (!this.playerOf.has(c) && c.readyState === WebSocket.OPEN) c.send(s);
  }
  private broadcast(obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  // ---- http ----

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (!this.authorized(req, url)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
      return this.handleApi(url, req, res);
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = join(this.d.webDir, p);
    if (!file.startsWith(this.d.webDir) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  }

  private handleApi(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = (cb: (body: unknown) => void) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { json(400, { error: 'invalid json' }); } });
    };
    switch (url.pathname) {
      case '/api/status': return json(200, this.status);
      case '/api/flips': {
        const n = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
        return json(200, this.recent.slice(-n).reverse());
      }
      case '/api/bazaar': return json(200, this.bazaarTop(Math.min(200, Number(url.searchParams.get('limit') ?? 50))));
      case '/api/profit': {
        const uuid = url.searchParams.get('uuid');
        if (!uuid) return json(400, { error: 'uuid required' });
        return json(200, this.d.tracker.summary(uuid, Number(url.searchParams.get('days') ?? 7) * 86_400_000));
      }
      case '/api/players': return json(200, this.d.tracker.trackedPlayers);
      case '/api/bot': case '/api/bot/status': return json(200, this.botStatus());
      case '/api/bot/start': case '/api/bot/stop':
        if (req.method !== 'POST') break;
        return void this.botControl(url.pathname.endsWith('start') ? 'login-on' : 'login-off').then((r) => { this.pushBot(); json(r.ok ? 200 : 500, { ok: r.ok, message: r.text, bot: this.botStatus() }); });
      case '/api/bot/autobuy':
        if (req.method !== 'POST') break;
        return readBody((b) => { const on = Boolean((b as { enabled?: boolean }).enabled); void this.botControl(on ? 'autobuy-on' : 'autobuy-off').then((r) => { this.pushBot(); json(200, { ok: r.ok, message: r.text, bot: this.botStatus() }); }); });
      case '/api/bot/control':
        if (req.method !== 'POST') break;
        return readBody((b) => { const o = b as { action?: string; text?: string }; void this.botControl(o.action ?? 'status', o.text).then((r) => { this.pushBot(); json(r.ok ? 200 : 400, { ok: r.ok, message: r.text, bot: this.botStatus() }); }); });
      case '/api/packs':
        if (req.method === 'GET') return json(200, this.listPacks());
        return readBody((b) => { const o = b as { pack?: string; mode?: 'merge' | 'replace' }; const r = this.loadPack(o.pack ?? url.searchParams.get('pack') ?? '', o.mode ?? (url.searchParams.get('mode') as 'merge' | 'replace') ?? 'merge'); json(r.ok ? 200 : 400, { ok: r.ok, message: r.text, settings: this.d.settings.current }); });
      case '/api/import/coflnet':
        if (req.method !== 'POST' && req.method !== 'PUT') break;
        return readBody((b) => {
          const o = b as { export?: unknown; mode?: 'merge' | 'replace' };
          const data = o && typeof o === 'object' && 'export' in o ? o.export : b;
          const mode = o?.mode ?? (url.searchParams.get('mode') as 'merge' | 'replace') ?? 'merge';
          const report = parseCoflnetExport(data);
          if (report.imported > 0 || Object.keys(report.settingsPatch).length) this.d.settings.update(applyImport(report, this.d.settings.current, mode === 'replace' ? 'replace' : 'merge'));
          json(200, report);
        });
      case '/api/settings':
        if (req.method === 'GET') return json(200, this.d.settings.current);
        if (req.method === 'PUT' || req.method === 'POST') return readBody((b) => json(200, this.d.settings.update(b as Partial<Settings>)));
        break;
      default: break;
    }
    json(404, { error: 'not found' });
  }
}
