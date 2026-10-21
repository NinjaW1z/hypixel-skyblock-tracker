import { EventEmitter } from 'node:events';
import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';
import type { BotConfig } from './config.js';
import type { BridgeClient } from './feed.js';
import { type MinecraftClient, windowTitle } from './minecraft.js';
import type { Store } from './store.js';
import { decide, rankFlips, type DecisionContext } from './decide.js';
import { GUI, findSlot, priceInLore, sameItemName, dumpWindow, itemText, containerSize } from './gui.js';
import { classifyChat, fmtCoins, priceForSign, stripColor } from './text.js';
import { log, sleep } from './log.js';
import type { Flip, Purchase, BotStatus, BotState, BotEvent, CreateAuctionRequest } from './types.js';

type BuyResult = 'bought' | 'failed' | 'dry' | 'unknown';

/**
 * The buyer: takes flips from the bridge, buys them through Hypixel's auction GUI (including
 * "bed" auctions that only become purchasable at purchaseAt), claims what it bought, answers
 * getInventory, and lists items the backend asks for with createAuction. One GUI flow at a time;
 * buying always wins over maintenance.
 */
export class Flipper extends EventEmitter {
  state: BotState = 'starting';
  paused = false;
  private stopped = false;
  private queue: Flip[] = [];
  private busy = false;
  private readonly recentBuys: { ts: number; price: number; cycle: number }[] = [];
  private readonly lastBuyByItem = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly events: BotEvent[] = [];
  private purse?: number;
  private purseAt = 0;
  private lastMaintenanceAt = 0;
  private maintenanceWanted = false;
  private authMessage?: string;
  private reconnectMs: number;
  private reconnectTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private notInSkyBlockSince = 0;
  private lastJoinAttempt = 0;
  private joinedAt = 0;
  private homeSent = false;
  private lastScoreboardAt = 0;
  private lastScoreboard = '';
  private readonly listRequests: CreateAuctionRequest[] = [];
  /** Active auctions seen in Manage Auctions last time we looked. */
  private activeAuctions = 0;
  private bridgeStarted = false;

  constructor(private readonly cfg: BotConfig, private readonly bridge: BridgeClient, private readonly mc: MinecraftClient | undefined, private readonly store: Store) {
    super();
    this.reconnectMs = cfg.timing.reconnectMinMs;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    const { bridge, mc } = this;
    bridge.on('flip', (f: Flip) => this.onFlip(f));
    bridge.on('createAuction', (r: CreateAuctionRequest) => this.onCreateAuction(r));
    bridge.on('getInventory', () => this.uploadInventory());
    bridge.on('chat', (t: string) => log.info(`bridge: ${stripColor(t)}`));
    bridge.on('execute', (c: string) => this.onExecute(c));
    bridge.on('connected', () => { this.uploadScoreboard(true); this.uploadInventory(); });
    if (mc) {
      mc.on('authCode', (msg: string) => { this.authMessage = msg; this.setState('auth'); this.event('warn', msg); });
      mc.on('spawn', () => this.onSpawn());
      mc.on('end', (reason: string) => this.onEnd(reason));
      mc.on('banned', (reason: string) => { this.setState('banned'); this.event('error', `account banned or flagged, not reconnecting: ${stripColor(reason).replace(/\n/g, ' ')}`); this.bridge.report(`banned: ${stripColor(reason).replace(/\n/g, ' ')}`); });
      mc.on('chat', (t: string) => this.onChat(t));
      this.setState('connecting');
      mc.connect();
    } else {
      this.setState('offline');
      this.event('info', 'offline mode: flips are logged, nothing is bought');
      this.startBridge(this.cfg.minecraft.account || 'offline');
    }
    this.tickTimer = setInterval(() => void this.tick(), 5_000);
    this.event('info', `skyflip bot started in ${this.cfg.mode} mode`);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.mc?.disconnect();
    this.setState('stopped');
    this.store.flush();
  }

  private startBridge(player: string, uuid = ''): void {
    if (this.bridgeStarted) return;
    this.bridgeStarted = true;
    this.bridge.start(player, uuid);
  }

  /** `execute` from the backend: a few console commands BAF users expect. */
  private onExecute(command: string): void {
    const c = command.trim();
    if (!c) return;
    if (c === 'inventory') { this.uploadInventory(); return; }
    if (c === 'pause') { this.paused = true; this.event('info', 'paused by the backend'); return; }
    if (c === 'resume') { this.paused = false; this.event('info', 'resumed by the backend'); return; }
    if (c === 'claim') { this.maintenanceWanted = true; return; }
    if (c.startsWith('/')) { if (this.mc?.connected) void this.mc.command(c).catch(() => {}); return; }
    log.info(`bridge execute (ignored): ${c}`);
  }

  private setState(s: BotState): void {
    if (this.state === s) return;
    this.state = s;
    log.debug('state', s);
  }

  private event(level: BotEvent['level'], text: string): void {
    this.events.push({ ts: Date.now(), level, text });
    if (this.events.length > 60) this.events.shift();
    (level === 'error' ? log.error : level === 'warn' ? log.warn : log.info)(text);
    if (level !== 'info' || /^(BOUGHT|LISTED|claimed|DRY RUN)/.test(text)) this.bridge.logLine(text);
  }

  status(): BotStatus {
    return {
      state: this.state, mode: this.cfg.mode, player: this.mc?.username || undefined, uuid: this.mc?.uuid || undefined,
      purse: this.purse, purseUpdatedAt: this.purseAt || undefined, location: this.mc?.location(),
      stats: this.store.stats, pending: this.store.open.slice(-30), events: this.events.slice(-25), authMessage: this.authMessage,
      paused: this.paused, updatedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------- connection

  private onSpawn(): void {
    const mc = this.mc!;
    this.authMessage = undefined;
    this.joinedAt = Date.now();
    this.homeSent = false;
    this.notInSkyBlockSince = 0;
    this.setState('joining');
    this.event('info', `spawned as ${mc.username}; waiting for SkyBlock`);
    this.startBridge(mc.username, mc.uuid);
    setTimeout(() => { if (!this.stopped && this.mc?.connected) this.reconnectMs = this.cfg.timing.reconnectMinMs; }, 60_000);
  }

  private onEnd(reason: string): void {
    this.busy = false;
    this.queue = [];
    if (this.stopped || this.state === 'banned') return;
    const text = stripColor(this.mc?.lastKick || reason || 'connection closed').replace(/\n/g, ' ');
    this.event('warn', `disconnected: ${text}; reconnecting in ${Math.round(this.reconnectMs / 1000)}s`);
    this.bridge.report(text);
    this.setState('connecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; if (!this.stopped) this.mc?.connect(); }, this.reconnectMs);
    this.reconnectMs = Math.min(this.cfg.timing.reconnectMaxMs, this.reconnectMs * 2);
  }

  private onChat(text: string): void {
    const ev = classifyChat(text);
    if (ev.type === 'limbo' || ev.type === 'afk') { this.notInSkyBlockSince = this.notInSkyBlockSince || Date.now() - 60_000; }
    else if (ev.type === 'ratelimited') { log.warn('hypixel asked us to slow down'); this.lastMaintenanceAt = Date.now(); }
    else if (ev.type === 'sold' && ev.price) { this.event('info', `sold ${ev.item ?? 'an item'} for ${fmtCoins(ev.price)}`); this.maintenanceWanted = true; }
    else if (ev.type === 'purchased' && !this.busy) { this.maintenanceWanted = true; }
  }

  /** Periodic: purse, SkyBlock watchdog, scoreboard upload, maintenance. */
  private async tick(): Promise<void> {
    const mc = this.mc;
    if (this.stopped || !mc) return;
    if (!mc.connected) return;
    const purse = mc.purse();
    if (purse !== undefined) { this.purse = purse; this.purseAt = Date.now(); }
    this.uploadScoreboard(false);
    const now = Date.now();
    if (!mc.inSkyBlock()) {
      if (!this.notInSkyBlockSince) this.notInSkyBlockSince = now;
      if (now - this.notInSkyBlockSince > 20_000 && now - this.lastJoinAttempt > 90_000 && !this.busy) {
        this.lastJoinAttempt = now;
        this.setState('joining');
        this.event('info', 'not in SkyBlock; joining');
        try {
          if (now - this.joinedAt > 120_000) { await mc.command('/lobby'); await sleep(4_000); }
          await mc.command('/play skyblock');
        } catch (e) { log.warn('join failed:', (e as Error).message); }
      }
      return;
    }
    if (this.notInSkyBlockSince) {
      this.notInSkyBlockSince = 0;
      this.event('info', `in SkyBlock at ${mc.location() ?? '?'}${purse !== undefined ? `, purse ${fmtCoins(purse)}` : ''}`);
    }
    if (!this.homeSent && this.cfg.minecraft.homeCommand && now - this.joinedAt > 6_000) {
      this.homeSent = true;
      try { await mc.command(this.cfg.minecraft.homeCommand); } catch { /* ignore */ }
    }
    if (this.state === 'joining' || this.state === 'connecting') this.setState(this.paused ? 'paused' : 'idle');
    if (this.busy) return;
    if (this.listRequests.length) { await this.runExclusive('listing', () => this.processListRequests()); return; }
    const due = this.maintenanceWanted || now - this.lastMaintenanceAt > this.cfg.timing.maintenanceIntervalMs;
    if (due && this.maintenanceAllowed(now)) {
      this.maintenanceWanted = false;
      this.lastMaintenanceAt = now;
      await this.runExclusive('maintenance', () => this.maintenance());
    }
  }

  private uploadScoreboard(force: boolean): void {
    const mc = this.mc;
    if (!mc?.connected) return;
    const lines = mc.sidebarLines();
    const key = lines.join('\n');
    const now = Date.now();
    if (!force && key === this.lastScoreboard && now - this.lastScoreboardAt < this.cfg.timing.scoreboardIntervalMs) return;
    if (!lines.length) return;
    this.lastScoreboard = key;
    this.lastScoreboardAt = now;
    this.bridge.uploadScoreboard(lines);
  }

  private uploadInventory(): void {
    const bot = this.mc?.bot;
    if (!bot) { this.bridge.uploadInventory({ slots: [], inventoryStart: 9, inventoryEnd: 45 }); return; }
    const inv = bot.inventory;
    this.bridge.uploadInventory({ slots: inv.slots, inventoryStart: inv.inventoryStart, inventoryEnd: inv.inventoryEnd, type: inv.type, title: inv.title });
  }

  /** Avoid starting a slow GUI flow right before the next API refresh drops new flips. */
  private maintenanceAllowed(now: number): boolean {
    const last = this.lastFlipCycleAt;
    if (!last) return true;
    // Hypixel refreshes about once a minute; flips come in the first ~10 s after it.
    const phase = (now - last) % 60_000;
    return phase > 10_000 && phase < 60_000 - this.cfg.timing.refreshGuardMs;
  }
  private lastFlipCycleAt = 0;

  private async runExclusive(what: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await fn(); } catch (e) { log.warn(`${what} failed:`, (e as Error).message); }
    finally {
      try { await this.mc?.closeWindow(); } catch { /* ignore */ }
      this.busy = false;
      if (this.state !== 'banned' && this.state !== 'stopped') this.setState(this.paused ? 'paused' : 'idle');
      if (this.queue.length) void this.drain();
    }
  }

  // ---------------------------------------------------------------- buying

  private decisionContext(flip: Flip): DecisionContext {
    return {
      cfg: this.cfg.buy, now: Date.now(), purse: this.purse, open: this.store.open, recentBuys: this.recentBuys, lastBuyByItem: this.lastBuyByItem,
      seen: this.seen, cycle: flip.apiLastUpdated, paused: this.paused,
    };
  }

  onFlip(flip: Flip): void {
    if (this.stopped) return;
    this.lastFlipCycleAt = Date.now();
    const d = decide(flip, this.decisionContext(flip));
    if (!d.buy) { log.info(`skip ${flip.itemName} ${fmtCoins(flip.price)} (+${fmtCoins(flip.profit)}): ${d.reason}`); this.store.stats.skipped++; return; }
    if (!this.mc) { this.seen.add(flip.uuid); this.event('info', `would buy ${flip.itemName} for ${fmtCoins(flip.price)} (+${fmtCoins(flip.profit)}, ${flip.kind}/${flip.risk})`); return; }
    if (!this.mc.connected || !this.mc.inSkyBlock()) { log.warn(`skip ${flip.itemName}: not in SkyBlock`); return; }
    this.queue.push(flip);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.stopped) {
        const ranked = rankFlips(this.queue);
        this.queue = [];
        const flip = ranked[0];
        const d = decide(flip, this.decisionContext(flip));
        if (!d.buy) { log.debug(`drop ${flip.itemName}: ${d.reason}`); continue; }
        this.queue = ranked.slice(1);
        this.seen.add(flip.uuid);
        this.setState('buying');
        const t0 = Date.now();
        const r = await this.buy(flip);
        log.info(`buy ${flip.itemName}: ${r} in ${Date.now() - t0}ms`);
        try { await this.mc?.closeWindow(); } catch { /* ignore */ }
      }
    } finally {
      this.busy = false;
      if (this.state !== 'banned' && this.state !== 'stopped') this.setState(this.paused ? 'paused' : 'idle');
    }
  }

  private async buy(flip: Flip): Promise<BuyResult> {
    const mc = this.mc!;
    const fail = (why: string): BuyResult => { this.store.stats.failed++; this.event('warn', `not bought: ${flip.itemName} for ${fmtCoins(flip.price)}: ${why}`); return 'failed'; };
    // Bed flips: open the auction just before purchaseAt, then keep trying until the buy button shows.
    const now = Date.now();
    if (flip.purchaseAt && flip.purchaseAt - now > this.cfg.buy.bedPreOpenMs) {
      const wait = flip.purchaseAt - now - this.cfg.buy.bedPreOpenMs;
      log.info(`bed flip ${flip.itemName}: waiting ${Math.round(wait / 1000)}s before opening`);
      await sleep(wait);
    }
    let view: Window;
    try {
      view = await mc.windowAfter(GUI.binView.title, () => mc.command(flip.command));
    } catch (e) {
      const chat = await mc.waitChat((t) => { const c = classifyChat(t); return c.type === 'buyFailed' ? c.reason : undefined; }, 200, 4_000);
      const cur = mc.currentWindow;
      if (cur && GUI.auctionView.title.test(windowTitle(cur))) return fail('not a BIN auction');
      return fail(chat ?? (e as Error).message);
    }
    const itemSlot = await mc.slot(view, { fallback: GUI.binView.item }, 1_500);
    let buyBtn = await mc.slot(view, GUI.binView.buy, 1_500);
    const bedUntil = (flip.purchaseAt ?? 0) + this.cfg.buy.bedGraceMs;
    let bedClicks = 0;
    while (!buyBtn && Date.now() < bedUntil && mc.currentWindow?.id === view.id) {
      // Grace period: Hypixel shows a bed in the buy slot; clicking it re-checks server-side.
      const bed = findSlot(view, { fallback: GUI.binView.buy.fallback });
      if (bed) { try { await mc.click(view, bed.slot); bedClicks++; } catch { break; } }
      await sleep(120);
      buyBtn = await mc.slot(view, GUI.binView.buy, 200);
      if (!buyBtn && mc.currentWindow && mc.currentWindow.id !== view.id && GUI.confirmPurchase.title.test(windowTitle(mc.currentWindow))) break;
    }
    if (bedClicks) log.info(`clicked ${bedClicks} times on the bed for ${flip.itemName}`);
    let confirm: Window | undefined;
    if (mc.currentWindow && mc.currentWindow.id !== view.id && GUI.confirmPurchase.title.test(windowTitle(mc.currentWindow))) confirm = mc.currentWindow;
    if (!confirm) {
      if (!buyBtn) {
        const collect = findSlot(view, GUI.binView.collect);
        return fail(collect ? 'already sold (collect button shown)' : `no buy button: ${dumpWindow(view)}`);
      }
      if (this.cfg.buy.requirePriceCheck) {
        if (itemSlot && flip.itemName && !sameItemName(itemSlot.text.name, flip.itemName)) return fail(`GUI shows "${stripColor(itemSlot.text.name)}", feed said "${flip.itemName}"`);
        const shown = priceInLore(buyBtn);
        if (Number.isFinite(shown) && shown > flip.price) return fail(`GUI price ${fmtCoins(shown)} > feed price ${fmtCoins(flip.price)}`);
        if (!Number.isFinite(shown)) log.warn(`could not read the price from the buy button: ${buyBtn.text.lore.map(stripColor).join(' | ')}`);
      }
      const purse = mc.purse();
      if (purse !== undefined) { this.purse = purse; this.purseAt = Date.now(); }
      if (purse !== undefined && purse - flip.price < this.cfg.buy.purseReserve) return fail(`purse ${fmtCoins(purse)} would drop under the reserve`);
      try { confirm = await mc.clickFor(view, buyBtn.slot, GUI.confirmPurchase.title); }
      catch (e) {
        const chat = await mc.waitChat((t) => { const c = classifyChat(t); return c.type === 'buyFailed' ? c.reason : undefined; }, 200, 3_000);
        return fail(chat ?? (e as Error).message);
      }
    }
    const confirmBtn = await mc.slot(confirm, GUI.confirmPurchase.confirm, 1_500);
    if (!confirmBtn) return fail(`no confirm button: ${dumpWindow(confirm)}`);
    if (this.cfg.mode === 'dry') {
      this.event('info', `DRY RUN: would confirm ${flip.itemName} for ${fmtCoins(flip.price)} (+${fmtCoins(flip.profit)}, ${flip.kind}/${flip.risk})`);
      return 'dry';
    }
    const purseBefore = this.purse;
    const outcome = mc.waitChat((t) => { const c = classifyChat(t); return c.type === 'purchased' || c.type === 'buyFailed' ? c : undefined; }, this.cfg.timing.chatTimeoutMs);
    try { await mc.click(confirm, confirmBtn.slot); }
    catch (e) { return fail(`confirm click: ${(e as Error).message}`); }
    const res = await outcome;
    let paid = flip.price;
    if (res?.type === 'purchased') paid = res.price || flip.price;
    else if (res?.type === 'buyFailed') return fail(res.reason);
    else {
      await sleep(800);
      const after = mc.purse();
      if (!(purseBefore !== undefined && after !== undefined && purseBefore - after >= flip.price * 0.99)) {
        this.event('warn', `unclear result for ${flip.itemName}: no purchase message and purse ${fmtCoins(purseBefore ?? NaN)} -> ${fmtCoins(after ?? NaN)}; the backend will confirm if it went through`);
        return 'unknown';
      }
    }
    this.recordPurchase(flip, paid);
    return 'bought';
  }

  private recordPurchase(flip: Flip, paid: number): void {
    const now = Date.now();
    this.recentBuys.push({ ts: now, price: paid, cycle: flip.apiLastUpdated });
    while (this.recentBuys.length && this.recentBuys[0].ts < now - 3_600_000) this.recentBuys.shift();
    this.lastBuyByItem.set(flip.ruleId || flip.itemId, now);
    if (!this.store.find(flip.uuid)) {
      this.store.add({ auctionId: flip.uuid, itemName: flip.itemName, itemId: flip.itemId, count: flip.count, price: paid, target: flip.target, boughtAt: now, state: 'bought', listings: 0, kind: flip.kind });
      this.store.stats.bought++;
      this.store.stats.spent += paid;
    }
    if (this.purse !== undefined) this.purse -= paid;
    this.event('info', `BOUGHT ${flip.itemName} for ${fmtCoins(paid)} (target ${fmtCoins(flip.target)}, +${fmtCoins(flip.profit)} expected)`);
    this.maintenanceWanted = true;
    this.uploadScoreboard(true);
  }

  // ---------------------------------------------------------------- maintenance: claim

  private async maintenance(): Promise<void> {
    const mc = this.mc!;
    if (this.cfg.mode === 'dry' || !this.cfg.sell.enabled) return;
    const open = this.store.open;
    const needClaim = open.some((p) => p.state === 'bought');
    const needReview = open.some((p) => p.state === 'listed') || this.activeAuctions > 0;
    if (!needClaim && !needReview) return;
    this.setState('claiming');
    if (needClaim) await this.claimBids().catch((e) => log.warn('claim bids:', (e as Error).message));
    await mc.closeWindow();
    if (needReview) { await this.reviewAuctions().catch((e) => log.warn('review auctions:', (e as Error).message)); await mc.closeWindow(); }
    this.uploadInventory();
  }

  private openAh(): Promise<Window> {
    const mc = this.mc!;
    return mc.windowAfter(GUI.ah.title, () => mc.command('/ah'));
  }

  /** Auction House → View Bids → Claim All (or each claimable item): purchased items into the inventory. */
  private async claimBids(): Promise<void> {
    const mc = this.mc!;
    for (let round = 0; round < 6; round++) {
      const ah = await this.openAh();
      const bidsBtn = await mc.slot(ah, GUI.ah.bids, 1_500);
      if (!bidsBtn) { log.warn(`no View Bids button: ${dumpWindow(ah)}`); return; }
      const bids = await mc.clickFor(ah, bidsBtn.slot, GUI.bids.title);
      await sleep(400);
      const claimAll = await mc.slot(bids, GUI.bids.claimAll, 1_200);
      if (claimAll) {
        await mc.click(bids, claimAll.slot);
        await sleep(600);
        this.markClaimed();
        this.event('info', 'claimed all bought items');
        return;
      }
      const claimable = findSlot(bids, GUI.bids.claimable);
      if (!claimable) { log.debug(`nothing to claim: ${dumpWindow(bids)}`); this.markClaimed(); return; }
      const view = await mc.clickFor(bids, claimable.slot, /Auction View/i);
      const collect = await mc.slot(view, GUI.binView.collect, 1_500);
      if (!collect) { log.warn(`no collect button: ${dumpWindow(view)}`); return; }
      await mc.click(view, collect.slot);
      await sleep(500);
      this.event('info', `claimed ${stripColor(claimable.text.name)}`);
      await mc.closeWindow();
    }
  }

  /** Everything we bought that is now in the inventory counts as claimed. */
  private markClaimed(): void {
    const inv = this.mc?.inventoryItems() ?? [];
    for (const p of this.store.open) {
      if (p.state !== 'bought') continue;
      const it = this.findInInventory(p, inv);
      if (it) { p.state = 'claimed'; const t = itemText(it); if (t?.uuid) p.itemUuid = t.uuid; }
    }
    this.store.save();
  }

  private findInInventory(p: Purchase, inv: Item[], used = new Set<number>()): Item | undefined {
    for (const it of inv) {
      if (used.has(it.slot)) continue;
      const t = itemText(it);
      if (!t) continue;
      if (p.itemUuid && t.uuid) { if (t.uuid === p.itemUuid) return it; continue; }
      if (t.skyblockId && p.itemId && t.skyblockId !== p.itemId && !(p.itemId === 'PET' && t.skyblockId === 'PET')) continue;
      if (sameItemName(t.name, p.itemName)) return it;
    }
    return undefined;
  }

  /** Manage Auctions: claim sold/expired auctions and update what we know about each listing. */
  private async reviewAuctions(): Promise<void> {
    const mc = this.mc!;
    const ah = await this.openAh();
    const manageBtn = await mc.slot(ah, GUI.ah.manage, 1_500);
    if (!manageBtn) { log.warn(`no Manage Auctions button: ${dumpWindow(ah)}`); return; }
    const manage = await mc.clickFor(ah, manageBtn.slot, GUI.manage.title);
    await sleep(500);
    const n = containerSize(manage);
    let active = 0;
    const listed = this.store.open.filter((p) => p.state === 'listed');
    const soldNow: { rec: Purchase; price: number }[] = [];
    for (let i = 0; i < n; i++) {
      const it = manage.slots[i];
      if (!it) continue;
      const t = itemText(it);
      if (!t || !t.lore.length) continue;
      const lore = t.lore.map(stripColor).join('\n');
      if (!/Ends in|Sold for|Expired|Click to claim|Status:/i.test(lore)) continue;
      if (/Ends in/i.test(lore)) active++;
      const rec = listed.find((p) => (t.uuid && p.itemUuid ? t.uuid === p.itemUuid : sameItemName(t.name, p.itemName)));
      if (!rec) continue;
      const sold = lore.match(/Sold for ([\d,]+) coins/i);
      if (sold) soldNow.push({ rec, price: Number(sold[1].replace(/,/g, '')) });
      else if (/Expired/i.test(lore)) { rec.state = 'claimed'; rec.lastError = 'expired'; }
    }
    this.activeAuctions = active;
    const claimAll = await mc.slot(manage, GUI.manage.claimAll, 800);
    if (claimAll) { await mc.click(manage, claimAll.slot); await sleep(700); this.event('info', 'claimed sold/expired auctions'); }
    else {
      const claimable = findSlot(manage, GUI.manage.claimable);
      if (claimable) {
        const view = await mc.clickFor(manage, claimable.slot, /Auction View/i);
        const collect = await mc.slot(view, GUI.binView.collect, 1_500);
        if (collect) { await mc.click(view, collect.slot); await sleep(500); }
      }
    }
    for (const s of soldNow) this.markSold(s.rec, s.price, Date.now());
    this.store.save();
  }

  private markSold(rec: Purchase, price: number, at: number): void {
    rec.state = 'sold'; rec.soldPrice = price; rec.soldAt = at;
    this.store.stats.sold++;
    this.store.stats.revenue += price;
    this.store.save();
    this.event('info', `SOLD ${rec.itemName} for ${fmtCoins(price)} (bought ${fmtCoins(rec.price)}, ${price >= rec.price ? '+' : ''}${fmtCoins(price - rec.price)} before fees)`);
  }

  // ---------------------------------------------------------------- listing on request

  private onCreateAuction(r: CreateAuctionRequest): void {
    if (!this.mc) { log.info(`offline: would list slot ${r.slot} (${r.itemName}) for ${fmtCoins(r.price)}`); return; }
    if (!this.cfg.sell.enabled) { this.bridge.clientError('createAuction refused: sell.enabled is false', r); return; }
    if (this.listRequests.some((x) => x.id === r.id && x.slot === r.slot)) return;
    this.listRequests.push(r);
    log.info(`createAuction queued: ${r.itemName} slot ${r.slot} for ${fmtCoins(r.price)} (${r.duration}h)`);
    if (!this.busy && this.mc.connected && this.mc.inSkyBlock()) void this.runExclusive('listing', () => this.processListRequests());
  }

  private async processListRequests(): Promise<void> {
    const mc = this.mc!;
    while (this.listRequests.length && !this.stopped) {
      const r = this.listRequests.shift()!;
      this.setState('listing');
      const inv = mc.inventoryItems();
      let item = inv.find((it) => it.slot === r.slot);
      let t = item ? itemText(item) : undefined;
      if (r.id && !(t?.uuid === r.id || t?.skyblockId === r.id)) {
        // Slot moved since the upload: find the item by its uuid instead.
        item = inv.find((it) => { const x = itemText(it); return x?.uuid === r.id; });
        t = item ? itemText(item) : undefined;
      }
      if (!item || !t) { this.bridge.clientError(`createAuction: slot ${r.slot} empty or not ${r.id}`, r); this.event('warn', `cannot list ${r.itemName}: slot ${r.slot} empty or holds another item`); continue; }
      const free = this.cfg.sell.maxAuctionSlots - this.cfg.sell.reserveAuctionSlots - this.activeAuctions;
      if (free <= 0) { this.bridge.clientError(`createAuction: no free auction slots (${this.activeAuctions} active)`, r); this.event('warn', `cannot list ${r.itemName}: no free auction slots`); continue; }
      if (this.cfg.mode === 'dry') { this.event('info', `DRY RUN: would list ${r.itemName} for ${fmtCoins(r.price)} (${r.duration}h)`); continue; }
      const rec = this.store.open.find((p) => (p.itemUuid ? p.itemUuid === t!.uuid : sameItemName(p.itemName, t!.name) && p.state !== 'listed'));
      try {
        await this.listItem(item, r.itemName || stripColor(t.name), r.price, r.duration);
        if (rec) { rec.state = 'listed'; rec.listPrice = r.price; rec.listedAt = Date.now(); rec.listings++; rec.lastError = undefined; rec.itemUuid = rec.itemUuid ?? t.uuid; }
        this.activeAuctions++;
        this.store.stats.listed++;
        this.store.save();
        this.event('info', `LISTED ${r.itemName || stripColor(t.name)} for ${fmtCoins(r.price)} (${r.duration}h)`);
      } catch (e) {
        if (rec) rec.lastError = (e as Error).message;
        this.bridge.clientError(`createAuction failed: ${(e as Error).message}`, r);
        this.event('warn', `could not list ${r.itemName}: ${(e as Error).message}`);
        await mc.closeWindow();
        await sleep(1_000);
      }
    }
    this.uploadInventory();
  }

  private async listItem(item: Item, itemName: string, price: number, hours: number): Promise<void> {
    const mc = this.mc!;
    const ah = await this.openAh();
    const manageBtn = await mc.slot(ah, GUI.ah.manage, 1_500);
    if (!manageBtn) throw new Error(`no Manage Auctions button: ${dumpWindow(ah)}`);
    const manage = await mc.clickFor(ah, manageBtn.slot, GUI.manage.title);
    const createBtn = await mc.slot(manage, GUI.manage.create, 1_500);
    if (!createBtn) throw new Error(`no Create Auction button: ${dumpWindow(manage)}`);
    let create = await mc.clickFor(manage, createBtn.slot, GUI.create.title);
    await sleep(300);
    const invSlot = containerSize(create) + (item.slot - 9);
    const placed = create.slots[invSlot];
    if (!placed || !sameItemName(itemText(placed)?.name ?? '', itemName)) throw new Error(`inventory slot ${item.slot} does not hold ${itemName} any more`);
    create = await this.clickMaybeNewWindow(create, invSlot, GUI.create.title);
    const inSlot = await mc.slot(create, { fallback: GUI.create.itemSlot }, 1_500);
    if (!inSlot || !sameItemName(inSlot.text.name, itemName)) throw new Error(`item did not land in the auction slot: ${dumpWindow(create)}`);
    if (!GUI.create.binTitle.test(windowTitle(create))) {
      const toggle = await mc.slot(create, GUI.create.toggle, 1_000);
      if (!toggle) throw new Error(`cannot switch to BIN: ${dumpWindow(create)}`);
      create = await this.clickMaybeNewWindow(create, toggle.slot, GUI.create.title);
      if (!GUI.create.binTitle.test(windowTitle(create))) throw new Error(`still not a BIN auction after toggling: ${dumpWindow(create)}`);
    }
    const priceBtn = await mc.slot(create, GUI.create.price, 1_500);
    if (!priceBtn) throw new Error(`no price button: ${dumpWindow(create)}`);
    create = await mc.windowAfter(GUI.create.title, () => mc.signAfter([priceForSign(price)], () => mc.click(create, priceBtn.slot)), this.cfg.timing.windowTimeoutMs + 2_000);
    await sleep(300);
    const priceNow = await mc.slot(create, GUI.create.price, 1_000);
    const shown = priceInLore(priceNow);
    if (Number.isFinite(shown) && Math.abs(shown - price) > Math.max(1, price * 0.001)) throw new Error(`price shows ${fmtCoins(shown)} after entering ${fmtCoins(price)}`);
    const wantDuration = durationPreset(hours);
    if (wantDuration) {
      const durBtn = await mc.slot(create, GUI.create.duration, 800);
      if (durBtn && !durBtn.text.lore.some((l) => wantDuration.test(stripColor(l)))) {
        try {
          const dur = await mc.clickFor(create, durBtn.slot, GUI.duration.title);
          const preset = await mc.slot(dur, { name: wantDuration }, 1_000);
          if (preset) create = await mc.clickFor(dur, preset.slot, GUI.create.title);
          else { const back = findSlot(dur, { name: /go back/i, fallback: 49 }); if (back) create = await mc.clickFor(dur, back.slot, GUI.create.title); else throw new Error('no preset and no back button'); }
        } catch (e) { log.warn(`duration not set (${(e as Error).message}); using Hypixel's default`); const cur = mc.currentWindow; if (!cur || !GUI.create.title.test(windowTitle(cur))) throw e; create = cur; }
      }
    }
    const createBtn2 = await mc.slot(create, GUI.create.create, 1_500);
    if (!createBtn2) throw new Error(`no Create button: ${dumpWindow(create)}`);
    const confirm = await mc.clickFor(create, createBtn2.slot, GUI.confirmListing.title);
    const confirmBtn = await mc.slot(confirm, GUI.confirmListing.confirm, 1_500);
    if (!confirmBtn) throw new Error(`no Confirm button: ${dumpWindow(confirm)}`);
    const outcome = mc.waitChat((t) => { const c = classifyChat(t); return c.type === 'listed' || c.type === 'listFailed' ? c : undefined; }, this.cfg.timing.chatTimeoutMs);
    await mc.click(confirm, confirmBtn.slot);
    const res = await outcome;
    if (res?.type === 'listFailed') throw new Error(res.reason);
    if (!res) {
      await sleep(600);
      if (mc.inventoryItems().some((it) => it.slot === item.slot && sameItemName(itemText(it)?.name ?? '', itemName))) throw new Error('item is still in the inventory after confirming');
    }
    await mc.closeWindow();
  }

  /** Click a slot; Hypixel either updates the window in place or opens a fresh one with the same title. */
  private async clickMaybeNewWindow(w: Window, slot: number, title: RegExp): Promise<Window> {
    const mc = this.mc!;
    let opened: Window | undefined;
    const onOpen = (nw: Window) => { if (title.test(windowTitle(nw))) opened = nw; };
    mc.bot?.on('windowOpen', onOpen);
    try {
      await mc.click(w, slot);
      await sleep(500);
    } finally { mc.bot?.removeListener('windowOpen', onOpen); }
    if (opened) return opened;
    const cur = mc.currentWindow;
    if (cur && title.test(windowTitle(cur))) return cur;
    throw new Error(`window closed after clicking slot ${slot}`);
  }
}

/** Hours → the preset name in Hypixel's duration menu ("48 Hours", "7 Days"). */
export function durationPreset(hours: number): RegExp | undefined {
  if (!(hours > 0)) return undefined;
  const h = Math.round(hours);
  if (h % 24 === 0 && h >= 72) { const d = h / 24; return new RegExp(`^(${d} days?|${h} hours?)$`, 'i'); }
  return new RegExp(`^(${h} hours?${h % 24 === 0 ? `|${h / 24} days?` : ''})$`, 'i');
}
