import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type Mode = 'live' | 'dry' | 'offline';

export interface BotConfig {
  /** live: buy and sell. dry: open auctions and verify, never confirm. offline: no Minecraft at all, only log what arrives. */
  mode: Mode;
  /**
   * The backend's modsocket endpoint: ws://host:3131/modsocket/<SKYFLIP_TOKEN>. A plain feed url
   * (ws://host:3131/ws) plus `token` is converted automatically.
   */
  feed: { url: string; token: string };
  minecraft: {
    host: string;
    port: number;
    /** Protocol version to speak. 1.8.9 keeps the container packets simple; Hypixel accepts it. */
    version: string;
    /** Microsoft account e-mail (only used as the cache key for the sign-in). */
    account: string;
    /** Where the Microsoft/Minecraft tokens are cached between runs. */
    authDir: string;
    /** Command run after joining SkyBlock to park the bot somewhere quiet. Empty to stay put. */
    homeCommand: string;
  };
  /** Bot-side safety net. What to buy is decided by the backend's auto-buy settings. */
  buy: {
    /** Never spend more than this on one flip. 0 = only the purse limits. */
    maxPrice: number;
    /** Skip a flip the bot received more than this long after detection (queue backlog, reconnects). */
    maxAgeMs: number;
    /** Keep at least this many coins in the purse. */
    purseReserve: number;
    maxBuysPerCycle: number;
    maxBuysPerHour: number;
    /** 0 = unlimited. */
    maxSpendPerHour: number;
    /** Stop buying while this many purchases are still unsold. 0 = unlimited. */
    maxOpenFlips: number;
    /** Don't buy the same item id twice within this window. */
    itemCooldownMs: number;
    /** Abort when the auction GUI shows a different item or price than the feed said. */
    requirePriceCheck: boolean;
    /** Keep re-opening a bed (grace period) auction this long after purchaseAt. */
    bedGraceMs: number;
    /** Open the auction this long before purchaseAt so the first click lands on time. */
    bedPreOpenMs: number;
  };
  sell: {
    /** Claim bought items and act on createAuction from the backend. */
    enabled: boolean;
    /** Leave this many auction slots free for manual use. */
    reserveAuctionSlots: number;
    /** Total auction slots the account has (14 by default, more with a booster cookie). */
    maxAuctionSlots: number;
  };
  timing: {
    /** Minimum gap between two commands/GUI clicks. */
    commandDelayMs: number;
    windowTimeoutMs: number;
    chatTimeoutMs: number;
    /** How often idle maintenance (claiming) is considered. */
    maintenanceIntervalMs: number;
    /** Don't start maintenance this close to the next expected API refresh. */
    refreshGuardMs: number;
    antiAfk: boolean;
    reconnectMinMs: number;
    reconnectMaxMs: number;
    /** Upload the sidebar (purse) to the backend at least this often. */
    scoreboardIntervalMs: number;
  };
  dataDir: string;
  debug: boolean;
}

export const DEFAULT_CONFIG: BotConfig = {
  mode: 'dry',
  feed: { url: 'ws://127.0.0.1:3131/ws', token: '' },
  minecraft: { host: 'mc.hypixel.net', port: 25565, version: '1.8.9', account: '', authDir: './data/auth', homeCommand: '/is' },
  buy: {
    maxPrice: 0, maxAgeMs: 25_000, purseReserve: 1_000_000, maxBuysPerCycle: 2, maxBuysPerHour: 40, maxSpendPerHour: 0, maxOpenFlips: 0,
    itemCooldownMs: 5 * 60_000, requirePriceCheck: true, bedGraceMs: 4_000, bedPreOpenMs: 1_500,
  },
  sell: { enabled: true, reserveAuctionSlots: 2, maxAuctionSlots: 14 },
  timing: {
    commandDelayMs: 350, windowTimeoutMs: 3_000, chatTimeoutMs: 3_500, maintenanceIntervalMs: 45_000, refreshGuardMs: 20_000, antiAfk: true,
    reconnectMinMs: 30_000, reconnectMaxMs: 10 * 60_000, scoreboardIntervalMs: 10_000,
  },
  dataDir: './data',
  debug: false,
};

type Deep<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K] };

function merge<T extends object>(base: T, over: Deep<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    if (v !== undefined && b && typeof b === 'object' && !Array.isArray(b) && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(b as object, v as object);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** Load config.json (path from SKYFLIP_BOT_CONFIG or ./config.json) over the defaults, then env overrides. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BotConfig {
  const path = resolve(cwd, env.SKYFLIP_BOT_CONFIG || 'config.json');
  let fileCfg: Deep<BotConfig> | undefined;
  if (existsSync(path)) {
    try { fileCfg = JSON.parse(readFileSync(path, 'utf8')) as Deep<BotConfig>; } catch (e) { throw new Error(`cannot parse ${path}: ${(e as Error).message}`); }
  }
  const cfg = merge(structuredClone(DEFAULT_CONFIG), fileCfg);
  if (env.SKYFLIP_URL || env.WEBSOCKET_URL) cfg.feed.url = (env.SKYFLIP_URL || env.WEBSOCKET_URL)!;
  if (env.SKYFLIP_TOKEN) cfg.feed.token = env.SKYFLIP_TOKEN;
  if (env.MC_ACCOUNT) cfg.minecraft.account = env.MC_ACCOUNT;
  if (env.MC_HOST) cfg.minecraft.host = env.MC_HOST;
  if (env.MC_PORT) cfg.minecraft.port = Number(env.MC_PORT);
  if (env.MC_VERSION) cfg.minecraft.version = env.MC_VERSION;
  if (env.MC_AUTH_DIR) cfg.minecraft.authDir = env.MC_AUTH_DIR;
  if (env.BOT_MODE) cfg.mode = env.BOT_MODE as Mode;
  if (env.DATA_DIR) cfg.dataDir = env.DATA_DIR;
  if (env.DEBUG) cfg.debug = env.DEBUG !== '' && env.DEBUG !== '0';
  validate(cfg);
  return cfg;
}

export function validate(c: BotConfig): void {
  if (!['live', 'dry', 'offline'].includes(c.mode)) throw new Error(`mode must be live, dry or offline (got ${c.mode})`);
  if (c.mode !== 'offline' && !c.minecraft.account) throw new Error('minecraft.account (your Microsoft account e-mail) is required unless mode is offline');
  if (!modsocketUrl(c.feed.url, c.feed.token)) throw new Error('feed.url must be ws://host:port/modsocket/<token>, or ws://host:port/ws with feed.token set');
}

/** ws://host/ws + token → ws://host/modsocket/<token>; an explicit /modsocket url is kept. */
export function modsocketUrl(url: string, token: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.pathname.startsWith('/modsocket/') && u.pathname.length > '/modsocket/'.length) return u.toString();
  if (!token) return undefined;
  u.pathname = `/modsocket/${token}`;
  u.search = '';
  return u.toString();
}
