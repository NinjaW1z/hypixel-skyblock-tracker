import { EventEmitter } from 'node:events';
import mineflayer, { type Bot } from 'mineflayer';
import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';
import { log, sleep } from './log.js';
import { stripColor, reasonText, parsePurseLine, looksLikeBan } from './text.js';
import type { BotConfig } from './config.js';
import { type Finder, type SlotMatch, findSlot, isPlaceholder, dumpWindow } from './gui.js';

export interface McOptions {
  host: string;
  port: number;
  version: string;
  account: string;
  authDir: string;
  /** 'offline' is only for the local mock server. */
  auth: 'microsoft' | 'offline';
  timing: BotConfig['timing'];
}

/**
 * Thin wrapper over mineflayer with what the flipper needs: a command queue with spacing,
 * "run this and wait for a window titled X", slot waits, sign input, the purse from the
 * sidebar, and kick/ban handling. Emits: spawn · end(reason) · banned(reason) · chat(text) ·
 * authCode(message) · window(Window).
 */
export class MinecraftClient extends EventEmitter {
  bot?: Bot;
  private lastCommandAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private pendingSign?: { lines: string[]; resolve: () => void };
  private antiAfkTimer?: NodeJS.Timeout;
  public banned = false;
  public lastKick = '';
  public username = '';
  public uuid = '';
  private readonly chatBuffer: { ts: number; text: string }[] = [];

  constructor(private readonly o: McOptions) { super(); }

  get connected(): boolean { return Boolean(this.bot?.entity); }

  connect(): void {
    if (this.banned) return;
    const o = this.o;
    log.info(`minecraft: connecting to ${o.host}:${o.port} as ${o.account} (protocol ${o.version}, ${o.auth} auth)`);
    const bot = mineflayer.createBot({
      host: o.host, port: o.port, version: o.version, username: o.account, auth: o.auth, profilesFolder: o.authDir,
      hideErrors: true, checkTimeoutInterval: 90_000, respawn: true, physicsEnabled: false,
      onMsaCode: (data: { user_code: string; verification_uri: string; message: string }) => {
        const msg = `Microsoft sign-in needed: open ${data.verification_uri} and enter code ${data.user_code}`;
        log.warn(msg);
        this.emit('authCode', msg);
      },
    } as Parameters<typeof mineflayer.createBot>[0]);
    this.bot = bot;
    bot.on('login', () => { this.username = bot.username; this.uuid = (bot as unknown as { _client: { uuid?: string } })._client.uuid ?? ''; log.info(`minecraft: logged in as ${this.username} (${this.uuid})`); });
    bot.once('spawn', () => { this.startAntiAfk(); this.emit('spawn'); });
    bot.on('messagestr', (text) => {
      const t = text;
      this.chatBuffer.push({ ts: Date.now(), text: t });
      if (this.chatBuffer.length > 200) this.chatBuffer.shift();
      this.emit('chat', t);
    });
    bot.on('kicked', (reason) => {
      const text = reasonText(reason);
      this.lastKick = text;
      log.warn(`minecraft: kicked: ${stripColor(text).replace(/\n/g, ' | ')}`);
      if (looksLikeBan(text)) { this.banned = true; this.emit('banned', text); }
    });
    bot.on('end', (reason) => { this.stopAntiAfk(); this.bot = undefined; this.pendingSign = undefined; this.emit('end', reason); });
    bot.on('error', (e) => log.warn('minecraft error:', (e as Error).message));
    bot.on('windowOpen', (w) => { log.debug('window open', dumpWindow(w as unknown as Window)); this.emit('window', w); });
    (bot as unknown as { _client: EventEmitter })._client.on('open_sign_entity', (packet: { location: unknown }) => {
      const p = this.pendingSign;
      if (!p) { log.debug('sign opened with nothing to write'); return; }
      this.pendingSign = undefined;
      const stringified = bot.supportFeature('sendStringifiedSignText' as never);
      const line = (i: number) => (stringified ? JSON.stringify(p.lines[i] ?? '') : (p.lines[i] ?? ''));
      (bot as unknown as { _client: { write: (name: string, params: unknown) => void } })._client.write('update_sign', {
        location: packet.location, isFrontText: true, text1: line(0), text2: line(1), text3: line(2), text4: line(3),
      });
      p.resolve();
    });
  }

  disconnect(): void {
    this.stopAntiAfk();
    this.bot?.quit();
    this.bot = undefined;
  }

  /** Send a chat line / command, spaced at least commandDelayMs apart, in order. */
  command(line: string): Promise<void> {
    const run = async () => {
      const wait = this.lastCommandAt + this.o.timing.commandDelayMs - Date.now();
      if (wait > 0) await sleep(wait);
      const bot = this.bot;
      if (!bot) throw new Error('not connected');
      log.debug('>', line);
      bot.chat(line);
      this.lastCommandAt = Date.now();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Wait for the next window whose title matches, optionally triggered by `action`. */
  async windowAfter(title: RegExp, action?: () => Promise<void>, timeoutMs = this.o.timing.windowTimeoutMs): Promise<Window> {
    const bot = this.bot;
    if (!bot) throw new Error('not connected');
    let done = false;
    const p = new Promise<Window>((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error(`no window matching ${title} within ${timeoutMs}ms (current: ${bot.currentWindow ? windowTitle(bot.currentWindow) : 'none'})`)); }, timeoutMs);
      const onOpen = (w: Window) => {
        if (title.test(windowTitle(w))) { cleanup(); resolve(w); }
        else log.debug(`window "${windowTitle(w)}" is not ${title}; waiting`);
      };
      const onEnd = () => { cleanup(); reject(new Error('disconnected while waiting for window')); };
      const cleanup = () => { done = true; clearTimeout(t); bot.removeListener('windowOpen', onOpen); bot.removeListener('end', onEnd); };
      bot.on('windowOpen', onOpen);
      bot.on('end', onEnd);
    });
    if (action) {
      try { await action(); } catch (e) { if (!done) { /* let the wait fail on its own */ } throw e; }
    }
    return p;
  }

  /** Wait until a slot matching the finder is present and not a loading placeholder. */
  async slot(w: Window, f: Finder, timeoutMs = this.o.timing.windowTimeoutMs): Promise<SlotMatch | undefined> {
    const check = () => { const m = findSlot(w, f); return m && !isPlaceholder(m) ? m : undefined; };
    const now = check();
    if (now) return now;
    return new Promise<SlotMatch | undefined>((resolve) => {
      const t = setTimeout(() => { cleanup(); resolve(check()); }, timeoutMs);
      const onUpdate = () => { const m = check(); if (m) { cleanup(); resolve(m); } };
      const onClose = () => { cleanup(); resolve(undefined); };
      const ev = w as unknown as EventEmitter;
      const cleanup = () => { clearTimeout(t); ev.removeListener('updateSlot', onUpdate); this.bot?.removeListener('windowClose', onClose); };
      ev.on('updateSlot', onUpdate);
      this.bot?.on('windowClose', onClose);
    });
  }

  async click(w: Window, slot: number): Promise<void> {
    const bot = this.bot;
    if (!bot) throw new Error('not connected');
    if (bot.currentWindow?.id !== w.id) throw new Error(`window ${windowTitle(w)} is no longer open`);
    const wait = this.lastCommandAt + this.o.timing.commandDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    log.debug(`click ${slot} in "${windowTitle(w)}"`);
    this.lastCommandAt = Date.now();
    await bot.clickWindow(slot, 0, 0);
  }

  /** Click a slot and wait for the window it opens. */
  clickFor(w: Window, slot: number, title: RegExp, timeoutMs?: number): Promise<Window> {
    return this.windowAfter(title, () => this.click(w, slot), timeoutMs);
  }

  /** Queue sign text for the next sign editor Hypixel opens, then run the action that opens it. */
  async signAfter(lines: string[], action: () => Promise<void>, timeoutMs = this.o.timing.windowTimeoutMs): Promise<void> {
    const p = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { if (this.pendingSign?.resolve === done) this.pendingSign = undefined; reject(new Error(`no sign editor opened within ${timeoutMs}ms`)); }, timeoutMs);
      const done = () => { clearTimeout(t); resolve(); };
      this.pendingSign = { lines, resolve: done };
    });
    await action();
    return p;
  }

  async closeWindow(): Promise<void> {
    const bot = this.bot;
    if (!bot?.currentWindow) return;
    try { bot.closeWindow(bot.currentWindow); } catch { /* ignore */ }
    await sleep(100);
  }

  get currentWindow(): Window | null { return this.bot?.currentWindow ?? null; }

  /** Wait for a chat line satisfying `pred`, also scanning lines received in the last `lookbackMs`. */
  waitChat<T>(pred: (text: string) => T | undefined, timeoutMs: number, lookbackMs = 0): Promise<T | undefined> {
    const bot = this.bot;
    if (!bot) return Promise.resolve(undefined);
    if (lookbackMs > 0) {
      const since = Date.now() - lookbackMs;
      for (const c of this.chatBuffer) if (c.ts >= since) { const r = pred(c.text); if (r !== undefined) return Promise.resolve(r); }
    }
    return new Promise<T | undefined>((resolve) => {
      const t = setTimeout(() => { cleanup(); resolve(undefined); }, timeoutMs);
      const onMsg = (text: string) => { const r = pred(text); if (r !== undefined) { cleanup(); resolve(r); } };
      const onEnd = () => { cleanup(); resolve(undefined); };
      const cleanup = () => { clearTimeout(t); bot.removeListener('messagestr', onMsg); bot.removeListener('end', onEnd); };
      bot.on('messagestr', onMsg);
      bot.on('end', onEnd);
    });
  }

  // ---- sidebar ----

  sidebarLines(): string[] {
    const sb = this.bot?.scoreboard?.sidebar;
    if (!sb) return [];
    try { return sb.items.map((i) => stripColor(String((i as unknown as { displayName: { toString(): string } }).displayName?.toString?.() ?? i.name))); } catch { return []; }
  }
  sidebarTitle(): string {
    const sb = this.bot?.scoreboard?.sidebar;
    return sb ? stripColor(reasonText(sb.title)) : '';
  }
  inSkyBlock(): boolean { return /SKYBLOCK|SKIBLOCK/i.test(this.sidebarTitle()); }
  purse(): number | undefined {
    for (const l of this.sidebarLines()) { const p = parsePurseLine(l); if (p !== undefined) return p; }
    return undefined;
  }
  location(): string | undefined {
    for (const l of this.sidebarLines()) { const m = l.match(/⏣\s*(.+)/); if (m) return m[1].trim(); }
    return undefined;
  }

  // ---- inventory ----
  inventoryItems(): Item[] {
    const inv = this.bot?.inventory;
    if (!inv) return [];
    return inv.slots.filter((s): s is Item => Boolean(s));
  }

  // ---- anti-afk ----
  private startAntiAfk(): void {
    if (!this.o.timing.antiAfk) return;
    this.stopAntiAfk();
    this.antiAfkTimer = setInterval(() => {
      const bot = this.bot;
      if (!bot?.entity || bot.currentWindow) return;
      try { void bot.look(bot.entity.yaw + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.3, false); } catch { /* ignore */ }
    }, 120_000 + Math.random() * 60_000);
  }
  private stopAntiAfk(): void { if (this.antiAfkTimer) { clearInterval(this.antiAfkTimer); this.antiAfkTimer = undefined; } }
}

export function windowTitle(w: Window): string {
  return stripColor(reasonText(w.title)).trim();
}
