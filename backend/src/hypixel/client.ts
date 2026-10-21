import { Pool, ProxyAgent, type Dispatcher } from 'undici';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { log, sleep } from '../util/log.js';
import type { AuctionsPage, EndedResponse } from './types.js';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliAsync = promisify(brotliDecompress);

export class HttpError extends Error {
  constructor(public status: number, public path: string, public retryAfterMs?: number) {
    super(`HTTP ${status} for ${path}`);
  }
}

/**
 * Thin, fast client for the auction endpoints.
 *  - one keep-alive connection pool (TLS handshakes are paid once)
 *  - gzip negotiated and decompressed on the libuv threadpool, never blocking the event loop
 *  - 429/5xx handled with capped backoff
 */
/** Pick up HTTPS_PROXY / NO_PROXY the way curl does; undici does not read them on its own. */
function proxyFor(origin: URL): string | undefined {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxy) return undefined;
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = origin.hostname;
  for (const rule of noProxy) {
    if (rule === '*' || host === rule || host.endsWith(rule.startsWith('.') ? rule : '.' + rule)) return undefined;
  }
  return proxy;
}

export class HypixelClient {
  private readonly pool: Dispatcher;
  private readonly origin: string;
  private readonly prefix: string;
  /** Bytes received this process lifetime (compressed). */
  public bytesIn = 0;
  public requests = 0;

  constructor(base: string = config.hypixelBase, connections = config.connections) {
    const u = new URL(base);
    this.origin = u.origin;
    this.prefix = u.pathname.replace(/\/$/, '');
    const common = {
      connections,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
      connect: { timeout: 10_000 },
      bodyTimeout: 20_000,
      headersTimeout: 15_000,
    };
    const proxy = proxyFor(u);
    if (proxy) {
      log.info(`using HTTPS proxy ${proxy} for ${u.origin}`);
      this.pool = new ProxyAgent({ uri: proxy, ...common });
    } else {
      this.pool = new Pool(u.origin, common);
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private async getJson<T>(path: string, attempt = 0): Promise<T> {
    this.requests++;
    const res = await this.pool.request({
      origin: this.origin,
      method: 'GET',
      path: this.prefix + path,
      headers: {
        'accept-encoding': 'gzip, deflate, br',
        'accept': 'application/json',
        'user-agent': 'skyflip/0.1 (+https://github.com/ninjaw1z/hypixel-skyblock-tracker)',
      },
    });
    const buf = Buffer.from(await res.body.arrayBuffer());
    this.bytesIn += buf.length;
    if (res.statusCode !== 200) {
      // Retry-After is seconds; cap wait so one bad answer cannot stall a cycle.
      const ra = Number(res.headers['retry-after']);
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5_000) : Math.min(250 * 2 ** attempt, 4_000);
      if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < 5) {
        log.warn(`HTTP ${res.statusCode} on ${path}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        return this.getJson<T>(path, attempt + 1);
      }
      throw new HttpError(res.statusCode, path, waitMs);
    }
    const enc = String(res.headers['content-encoding'] ?? '');
    let body: Buffer;
    if (enc.includes('gzip')) body = await gunzipAsync(buf);
    else if (enc.includes('br')) body = await brotliAsync(buf);
    else if (enc.includes('deflate')) body = await inflateAsync(buf);
    else body = buf;
    return JSON.parse(body.toString('utf8')) as T;
  }

  /** Fetch one page of active auctions. */
  async auctionsPage(page: number): Promise<AuctionsPage> {
    return this.getJson<AuctionsPage>(`/skyblock/auctions?page=${page}`);
  }

  /**
   * Fetch a page and insist its lastUpdated matches the snapshot being assembled.
   * Hypixel's edge cache can hand back the previous snapshot for a page for a second
   * or two after page 0 has flipped. Retrying is the only remedy.
   */
  async auctionsPageFor(page: number, lastUpdated: number): Promise<AuctionsPage> {
    let p = await this.auctionsPage(page);
    for (let i = 0; i < config.stalePageRetries && p.lastUpdated < lastUpdated; i++) {
      log.debug(`page ${page} stale (${p.lastUpdated} < ${lastUpdated}), retry ${i + 1}`);
      await sleep(config.stalePageRetryDelayMs);
      p = await this.auctionsPage(page);
    }
    if (p.lastUpdated < lastUpdated) log.warn(`page ${page} still stale after retries; using it anyway`);
    return p;
  }

  /** Auctions that ended (sold or expired with bids) in the last ~60s. */
  async ended(): Promise<EndedResponse> {
    return this.getJson<EndedResponse>('/skyblock/auctions_ended');
  }
}
