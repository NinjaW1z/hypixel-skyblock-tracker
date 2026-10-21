import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from '../util/log.js';
import type { Flip } from '../flips/detector.js';
import type { SettingsStore, Settings } from '../flips/settings.js';

export interface Status {
  connectedAt: number;
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
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
};

/**
 * One HTTP server does three jobs: static web UI, a small REST API, and the WebSocket
 * feed consumed by both the web UI and the Minecraft mod.
 */
export class FeedServer {
  private readonly wss: WebSocketServer;
  private readonly recent: Flip[] = [];
  public status: Status;

  constructor(private readonly port: number, private readonly webDir: string, private readonly settings: SettingsStore) {
    this.status = {
      connectedAt: Date.now(), apiLastUpdated: 0, detectLagMs: 0, fetchMs: 0, intervalMs: 0, pages: 0, totalAuctions: 0,
      newAuctions: 0, flipsThisCycle: 0, flipsTotal: 0, salesTracked: 0, salesKeys: 0, lowestBinKeys: 0, requests: 0, bytesIn: 0, cycles: 0,
    };
    const server = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', settings: this.settings.current, status: this.status, flips: this.recent.slice(-50) }));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as { type: string; settings?: Partial<Settings> };
          if (msg.type === 'settings' && msg.settings) this.settings.update(msg.settings);
        } catch { /* ignore malformed */ }
      });
    });
    settings.onChange((s) => this.broadcast({ type: 'settings', settings: s }));
    server.listen(port, () => log.info(`web UI + feed on http://localhost:${port}  (ws://localhost:${port}/ws)`));
  }

  get clients(): number { return this.wss.clients.size; }

  publishFlip(f: Flip): void {
    this.recent.push(f);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    this.broadcast({ type: 'flip', flip: f });
  }

  publishStatus(): void {
    this.broadcast({ type: 'status', status: this.status });
  }

  private broadcast(obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/')) return this.handleApi(url, req, res);
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = join(this.webDir, p);
    if (!file.startsWith(this.webDir) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  }

  private handleApi(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/status') return json(200, this.status);
    if (url.pathname === '/api/flips') {
      const n = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
      return json(200, this.recent.slice(-n).reverse());
    }
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') return json(200, this.settings.current);
      if (req.method === 'PUT' || req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try { json(200, this.settings.update(JSON.parse(body))); } catch { json(400, { error: 'invalid json' }); }
        });
        return;
      }
    }
    json(404, { error: 'not found' });
  }
}
