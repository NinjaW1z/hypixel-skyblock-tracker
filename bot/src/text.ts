const COLOR_RE = /§[0-9a-fk-or]/gi;

/** Remove Minecraft § colour codes. */
export function stripColor(s: string | undefined | null): string {
  return (s ?? '').replace(COLOR_RE, '');
}

/** Normalise an item name for comparison: no colours, no star glyphs, collapsed spaces, lower case. */
export function normalizeName(s: string | undefined | null): string {
  return stripColor(s).replace(/[✪➊➋➌➍➎⚚✦◆]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Parse "1,234,567" / "1.2M" / "12k" style coin amounts. Returns NaN when nothing parses. */
export function parseCoins(s: string | undefined | null): number {
  if (!s) return NaN;
  const m = stripColor(s).replace(/\s/g, '').match(/^([\d.,]+)([kmb])?(?:coins?)?$/i);
  if (!m) return NaN;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return NaN;
  const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'b'] : 1;
  return Math.round(base * mult);
}

/** Find the first coin amount in a lore line like "§7Price: §61,234,567 coins". */
export function coinsInLine(line: string | undefined | null): number {
  const t = stripColor(line);
  const m = t.match(/([\d]{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*coins?/i);
  return m ? Number(m[1].replace(/,/g, '')) : NaN;
}

/** Purse / Piggy line on the SkyBlock sidebar: "Purse: 1,234,567" (may carry a "(+123)" delta). */
export function parsePurseLine(line: string | undefined | null): number | undefined {
  const t = stripColor(line);
  const m = t.match(/(?:Purse|Piggy):\s*([\d,]+)/i);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function fmtCoins(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'b' : a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'm' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k' : String(Math.round(a));
  return (n < 0 ? '-' : '') + s;
}

export type ChatEvent =
  | { type: 'purchased'; item: string; price: number }
  | { type: 'claimed'; item: string }
  | { type: 'listed'; item?: string }
  | { type: 'sold'; item?: string; price?: number }
  | { type: 'buyFailed'; reason: string }
  | { type: 'listFailed'; reason: string }
  | { type: 'ratelimited' }
  | { type: 'limbo' }
  | { type: 'afk' }
  | { type: 'none' };

/**
 * Classify a Hypixel chat line. Patterns are deliberately loose: Hypixel rewords these now and
 * then, and a false "none" only costs a timeout while a false positive could lose a flip.
 */
export function classifyChat(raw: string): ChatEvent {
  const t = stripColor(raw).trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^You purchased (.+?) for ([\d,]+) coins!?/i))) return { type: 'purchased', item: m[1].trim(), price: Number(m[2].replace(/,/g, '')) };
  if ((m = t.match(/^You claimed (.+?) from (?:the )?auction house!?/i))) return { type: 'claimed', item: m[1].trim() };
  if ((m = t.match(/^(?:\[Auction\] )?(.+?) bought (.+?) for ([\d,]+) coins/i)) && !/^You /.test(t)) return { type: 'sold', item: m[2].trim(), price: Number(m[3].replace(/,/g, '')) };
  if (/^You collected ([\d,]+) coins? from selling/i.test(t)) return { type: 'sold' };
  if ((m = t.match(/^(?:BIN )?Auction started for (.+?)!?$/i))) return { type: 'listed', item: m[1].trim() };
  if (/claimed .* from the auction house|collected your items?|You claimed \d+ auctions?/i.test(t)) return { type: 'claimed', item: '' };
  if (/already (?:been )?(?:sold|purchased|claimed|bought)|was sold|no longer (?:exists|available)|auction (?:is|was) (?:already )?(?:over|ended|sold|not found|cancelled)|this auction (?:has|was) ended/i.test(t)) return { type: 'buyFailed', reason: t };
  if (/cannot afford|don'?t have enough coins|not enough coins|insufficient/i.test(t)) return { type: 'buyFailed', reason: t };
  if (/not found|does not exist|error with the auction/i.test(t) && /auction/i.test(t)) return { type: 'buyFailed', reason: t };
  if (/you (?:can'?t|cannot) (?:buy|purchase) your own/i.test(t)) return { type: 'buyFailed', reason: t };
  if (/inventory (?:is )?full/i.test(t)) return { type: 'buyFailed', reason: t };
  if (/reached (?:the )?maximum (?:number|amount) of (?:active )?auctions|too many (?:active )?auctions|can'?t create (?:any )?more auctions/i.test(t)) return { type: 'listFailed', reason: t };
  if (/cannot (?:be )?(?:sold|auctioned|listed)|not allowed to (?:sell|auction)|soulbound|co-?op ?bound/i.test(t)) return { type: 'listFailed', reason: t };
  if (/slow down|please wait|you are (?:sending|doing) (?:commands|this) too (?:fast|quickly)|too many requests|rate ?limit/i.test(t)) return { type: 'ratelimited' };
  if (/spawned in limbo|sent to limbo|you are in limbo|limbo/i.test(t) && !/skyblock/i.test(t)) return { type: 'limbo' };
  if (/you are afk|were afk|afk\b/i.test(t) && /move|return|kick/i.test(t)) return { type: 'afk' };
  return { type: 'none' };
}

/** Does a kick reason look like an account ban rather than a routine disconnect? */
export function looksLikeBan(reason: string): boolean {
  const t = stripColor(reason).toLowerCase();
  return /\bbanned\b|\bban id\b|suspicious activity|account is (?:temporarily|permanently) (?:banned|suspended)|watchdog/.test(t);
}

/** Extract text from a (possibly JSON) chat/kick reason. */
export function reasonText(reason: unknown): string {
  if (typeof reason === 'string') {
    try { return reasonText(JSON.parse(reason)); } catch { return reason; }
  }
  if (reason && typeof reason === 'object') {
    const o = reason as { text?: string; extra?: unknown[]; translate?: string; with?: unknown[]; value?: unknown };
    if ('value' in o && o.value !== undefined) return reasonText(o.value);
    let s = o.text ?? o.translate ?? '';
    if (Array.isArray(o.extra)) s += o.extra.map(reasonText).join('');
    if (Array.isArray(o.with)) s += ' ' + o.with.map(reasonText).join(' ');
    return s;
  }
  return String(reason ?? '');
}

/** Sign text for a price: plain digits, Hypixel parses "1234567" and also "1.2m". */
export function priceForSign(price: number): string {
  return String(Math.max(1, Math.floor(price)));
}
