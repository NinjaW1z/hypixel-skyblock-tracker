import { stripColor, normalizeName, coinsInLine, reasonText } from './text.js';

/** The subset of a prismarine Item the GUI helpers read. */
export interface ItemLike {
  name?: string;
  displayName?: string;
  count?: number;
  nbt?: unknown;
  slot?: number;
}
export interface WindowLike {
  id?: number;
  title: string;
  slots: (ItemLike | null)[];
}

export interface ItemText {
  name: string;
  lore: string[];
  /** ExtraAttributes.id (SkyBlock item id) when present. */
  skyblockId?: string;
  /** ExtraAttributes.uuid when present. */
  uuid?: string;
}

function nbtValue(v: unknown): unknown {
  if (v && typeof v === 'object' && 'value' in (v as object)) return (v as { value: unknown }).value;
  return v;
}
function nbtGet(obj: unknown, key: string): unknown {
  const o = nbtValue(obj);
  if (!o || typeof o !== 'object') return undefined;
  return (o as Record<string, unknown>)[key];
}
function textOf(v: unknown): string {
  const raw = nbtValue(v);
  if (typeof raw !== 'string') return '';
  if (raw.startsWith('{') || raw.startsWith('[') || raw.startsWith('"')) {
    try { return reasonText(JSON.parse(raw)); } catch { /* plain string */ }
  }
  return raw;
}

/** Display name, lore and ExtraAttributes of an item, from its NBT. Tolerates missing pieces. */
export function itemText(item: ItemLike | null | undefined): ItemText | undefined {
  if (!item) return undefined;
  const display = nbtGet(item.nbt, 'display');
  let name = textOf(nbtGet(display, 'Name'));
  if (!name) name = item.displayName ?? item.name ?? '';
  const loreRaw = nbtValue(nbtGet(display, 'Lore'));
  let lore: string[] = [];
  const loreList = nbtValue(loreRaw);
  if (Array.isArray(loreList)) lore = loreList.map((l) => textOf(l));
  else if (loreRaw && typeof loreRaw === 'object' && Array.isArray((loreRaw as { value?: unknown }).value)) lore = ((loreRaw as { value: unknown[] }).value).map((l) => textOf(l));
  const extra = nbtGet(item.nbt, 'ExtraAttributes');
  const id = nbtValue(nbtGet(extra, 'id'));
  const uuid = nbtValue(nbtGet(extra, 'uuid'));
  return { name, lore, skyblockId: typeof id === 'string' ? id : undefined, uuid: typeof uuid === 'string' ? uuid : undefined };
}

export interface SlotMatch { slot: number; item: ItemLike; text: ItemText }

/** All non-empty slots with their decoded text, optionally limited to the container part. */
export function describe(w: WindowLike, limit?: number): SlotMatch[] {
  const out: SlotMatch[] = [];
  const n = limit ?? w.slots.length;
  for (let i = 0; i < n && i < w.slots.length; i++) {
    const it = w.slots[i];
    if (!it) continue;
    const text = itemText(it);
    if (text) out.push({ slot: i, item: it, text });
  }
  return out;
}

export interface Finder {
  /** Match against the stripped display name. */
  name?: RegExp;
  /** Match against any stripped lore line. */
  lore?: RegExp;
  /** Reject when the name matches. */
  notName?: RegExp;
  /** Slot to use when nothing matches by text (Hypixel's layout is stable). */
  fallback?: number;
  /** Only search the container part of the window (not the player inventory). */
  containerOnly?: boolean;
}

/** Find a slot by name/lore, else by fallback index when that slot holds an item. */
export function findSlot(w: WindowLike, f: Finder): SlotMatch | undefined {
  const limit = f.containerOnly === false ? undefined : containerSize(w);
  for (const m of describe(w, limit)) {
    const name = stripColor(m.text.name);
    if (f.notName && f.notName.test(name)) continue;
    if (f.name && f.name.test(name)) return m;
    if (f.lore && m.text.lore.some((l) => f.lore!.test(stripColor(l)))) return m;
  }
  if (f.fallback !== undefined) {
    const it = w.slots[f.fallback];
    if (it) { const text = itemText(it); if (text) return { slot: f.fallback, item: it, text }; }
  }
  return undefined;
}

/** Hypixel's menus are chests: 9 × rows of container slots, then the 36 player slots. */
export function containerSize(w: WindowLike): number {
  const n = w.slots.length;
  return n > 36 ? n - 36 : n;
}

/** First coin amount found in the lore of a slot. */
export function priceInLore(m: SlotMatch | undefined): number {
  if (!m) return NaN;
  for (const l of m.text.lore) {
    const c = coinsInLine(l);
    if (Number.isFinite(c)) return c;
  }
  return NaN;
}

/** Is this a "still loading" placeholder (Hypixel fills menus a tick later)? */
export function isPlaceholder(m: SlotMatch | undefined): boolean {
  if (!m) return true;
  const n = stripColor(m.text.name).trim();
  return n === '' || /^loading/i.test(n) || (m.item.name ?? '').includes('stained_glass_pane') && (n === ' ' || n === '');
}

/** One-line dump of a window for logs. */
export function dumpWindow(w: WindowLike): string {
  const parts = describe(w, containerSize(w)).map((m) => `${m.slot}:${stripColor(m.text.name).trim() || m.item.name}`);
  return `"${stripColor(w.title)}" [${parts.join(', ')}]`;
}

export function sameItemName(a: string, b: string): boolean {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Hypixel auction house menus. Names are matched case-insensitively against the stripped
 * display name; fallbacks are the slot numbers Hypixel has used for years. Change here if
 * Hypixel moves things.
 */
export const GUI = {
  binView: {
    title: /^BIN Auction View$/i,
    item: 13,
    buy: { name: /^buy item right now$/i, fallback: 31 } as Finder,
    collect: { name: /^(collect auction|claim item|claim)$/i } as Finder,
  },
  auctionView: { title: /^Auction View$/i },
  confirmPurchase: {
    title: /^Confirm Purchase$/i,
    confirm: { name: /^confirm$/i, fallback: 11 } as Finder,
  },
  ah: {
    title: /^Auction House$/i,
    bids: { name: /^view bids$/i, fallback: 13 } as Finder,
    manage: { name: /^manage auctions$/i, fallback: 15 } as Finder,
  },
  bids: {
    title: /^Your Bids$/i,
    claimAll: { name: /^claim all$/i } as Finder,
    claimable: { lore: /click to claim|you (?:bought|won)/i } as Finder,
  },
  manage: {
    title: /^Manage Auctions$/i,
    create: { name: /^create (bin )?auction$/i, fallback: 24 } as Finder,
    claimAll: { name: /^claim all$/i } as Finder,
    claimable: { lore: /sold for|expired|click to claim/i } as Finder,
  },
  create: {
    title: /^Create (BIN )?Auction$/i,
    binTitle: /^Create BIN Auction$/i,
    itemSlot: 13,
    toggle: { name: /auction (?:type|mode)|switch to|bin auction$|^bin$/i, lore: /click to switch|switch to (?:bin|auction)/i, fallback: 48 } as Finder,
    price: { name: /^(starting bid|item price|price)$/i, fallback: 31 } as Finder,
    duration: { name: /^(auction )?duration$/i, fallback: 33 } as Finder,
    create: { name: /^create (bin )?auction$/i, fallback: 29 } as Finder,
  },
  duration: { title: /duration/i },
  confirmListing: {
    title: /^Confirm$/i,
    confirm: { name: /^confirm$/i, fallback: 11 } as Finder,
  },
};
