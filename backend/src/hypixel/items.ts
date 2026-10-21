import type { HypixelClient } from './client.js';
import { log } from '../util/log.js';

interface ItemsResponse { success: boolean; items: { id: string; name: string; tier?: string; category?: string }[] }

/**
 * Item id → in-game display name, from Hypixel's public resources endpoint.
 * Used for bazaar product names and the `/bz <name>` command. Refreshed every few hours.
 */
export class ItemNames {
  private map = new Map<string, string>();
  constructor(private readonly client: HypixelClient) {}

  get size(): number { return this.map.size; }

  name(id: string): string | undefined {
    const hit = this.map.get(id);
    if (hit) return hit;
    // Bazaar enchantment books are not in the items resource: ENCHANTMENT_ULTIMATE_CHIMERA_1 -> "Chimera I".
    const m = /^ENCHANTMENT_(?:ULTIMATE_)?([A-Z_]+?)_(\d+)$/.exec(id);
    if (m) return `${title(m[1])} ${roman(Number(m[2]))}`;
    return undefined;
  }

  async refresh(): Promise<void> {
    try {
      const res = await this.client.get<ItemsResponse>('/resources/skyblock/items');
      const next = new Map<string, string>();
      for (const it of res.items) if (it.id && it.name) next.set(it.id, it.name);
      this.map = next;
      log.info(`item names loaded: ${next.size}`);
    } catch (e) {
      log.warn('item names refresh failed:', (e as Error).message);
    }
  }

  start(intervalMs = 6 * 3_600_000): void {
    void this.refresh();
    setInterval(() => void this.refresh(), intervalMs).unref();
  }
}

function title(s: string): string {
  return s.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function roman(n: number): string {
  const t: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, r] of t) while (n >= v) { out += r; n -= v; }
  return out || String(n);
}
