import { request } from 'undici';
import { log } from '../util/log.js';

/** Minecraft name → UUID (undashed, lower case) via Mojang, cached. Injectable fetch for tests. */
export class MojangResolver {
  private readonly cache = new Map<string, { uuid: string; at: number }>();

  constructor(private readonly fetcher: (name: string) => Promise<string | undefined> = defaultFetch, private readonly ttlMs = 24 * 3_600_000) {}

  async resolve(name: string): Promise<string | undefined> {
    const key = name.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,16}$/.test(key)) return undefined;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.uuid;
    try {
      const uuid = await this.fetcher(key);
      if (uuid) { this.cache.set(key, { uuid, at: Date.now() }); return uuid; }
    } catch (e) { log.warn(`mojang lookup for ${name} failed:`, (e as Error).message); }
    return hit?.uuid;
  }

  /** Pre-seed, e.g. from a bot that reports its own UUID. */
  remember(name: string, uuid: string): void {
    const u = uuid.replace(/-/g, '').toLowerCase();
    if (/^[0-9a-f]{32}$/.test(u)) this.cache.set(name.trim().toLowerCase(), { uuid: u, at: Date.now() });
  }
}

async function defaultFetch(name: string): Promise<string | undefined> {
  const res = await request(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { headersTimeout: 8_000, bodyTimeout: 8_000 });
  if (res.statusCode === 404 || res.statusCode === 204) { await res.body.text(); return undefined; }
  if (res.statusCode !== 200) { await res.body.text(); throw new Error(`HTTP ${res.statusCode}`); }
  const body = (await res.body.json()) as { id?: string };
  return body.id?.replace(/-/g, '').toLowerCase();
}
