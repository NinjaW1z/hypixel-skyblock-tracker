import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/log.js';
import type { SettingsStore, PacingSettings } from '../flips/settings.js';

export interface PacingControl {
  status(): { desired: 'on' | 'off'; pausedBy?: string };
  pause(by: string): Promise<void>;
  resume(): Promise<void>;
}

export interface PacingState {
  day: string;
  onlineMsToday: number;
  phase: 'online' | 'break' | 'human-break' | 'off';
  /** End of the current phase (session, break or short break). */
  phaseEndsAt: number;
  /** End of the current session, kept across short breaks. */
  sessionEndsAt: number;
  nextHumanBreakAt: number;
  lastTickAt: number;
}

export interface PacingStatus extends PacingState { enabled: boolean; humanize: boolean; dailyCapMinutes: number }

/**
 * Stealth session pacing (BAF's `stealth_*`) and humanization (`humanization_*`), driven from
 * the backend by starting/stopping the bot service. Sessions and breaks are drawn from a
 * triangular distribution between the configured bounds; a daily online allowance is enforced
 * and the day's state is persisted so a restart does not reset it. Only acts while the owner's
 * login switch is on; off by default.
 */
export class PacingScheduler {
  private readonly file: string;
  private state: PacingState;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly settings: SettingsStore, private readonly service: PacingControl, dataDir: string, opts: { now?: () => number; random?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'pacing-state.json');
    this.state = { day: this.dayOf(this.now()), onlineMsToday: 0, phase: 'off', phaseEndsAt: 0, sessionEndsAt: 0, nextHumanBreakAt: 0, lastTickAt: this.now() };
    if (existsSync(this.file)) { try { this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, 'utf8')) }; } catch { /* fresh */ } }
  }

  start(tickMs = 30_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  status(): PacingStatus {
    const p = this.settings.current.pacing;
    return { ...this.state, enabled: p.enabled, humanize: p.humanize, dailyCapMinutes: p.dailyOnlineMinutes };
  }

  async tick(): Promise<void> {
    const p = this.settings.current.pacing;
    const now = this.now();
    const svc = this.service.status();
    const day = this.dayOf(now);
    if (day !== this.state.day) { this.state.day = day; this.state.onlineMsToday = 0; }
    const ours = (svc.pausedBy ?? '').startsWith('pacing');
    if (!p.enabled || svc.desired !== 'on') {
      // Not our business: make sure we are not the reason the bot is stopped.
      if (ours) await this.service.resume();
      if (svc.desired === 'on' && this.state.phase !== 'off') this.state.onlineMsToday += Math.max(0, now - this.state.lastTickAt);
      this.state.phase = 'off';
      this.state.lastTickAt = now;
      this.save();
      return;
    }
    const capMs = p.dailyOnlineMinutes > 0 ? p.dailyOnlineMinutes * 60_000 : Infinity;
    switch (this.state.phase) {
      case 'off':
        this.beginSession(now, p);
        break;
      case 'online': {
        this.state.onlineMsToday += Math.max(0, now - this.state.lastTickAt);
        if (this.state.onlineMsToday >= capMs) { await this.beginBreak(now, p, 'daily allowance used', this.nextMidnight(now)); break; }
        if (now >= this.state.phaseEndsAt) { await this.beginBreak(now, p, 'session over'); break; }
        if (p.humanize && now >= this.state.nextHumanBreakAt) {
          const len = tri(p.humanMinBreakMinutes, p.humanMaxBreakMinutes, this.random) * 60_000;
          this.state.phase = 'human-break';
          this.state.phaseEndsAt = now + len;
          await this.service.pause(`pacing: short break until ${new Date(this.state.phaseEndsAt).toISOString()}`);
          log.info(`pacing: humanization break for ${Math.round(len / 60_000)} min`);
        }
        break;
      }
      case 'break':
      case 'human-break':
        if (!ours && !svc.pausedBy) { /* owner restarted it by hand: respect that and carry on online */ this.beginSession(now, p); break; }
        if (now >= this.state.phaseEndsAt) {
          if (this.state.onlineMsToday >= capMs) { this.state.phaseEndsAt = this.nextMidnight(now); break; }
          const resumeSession = this.state.phase === 'human-break';
          await this.service.resume();
          if (resumeSession) { this.state.phase = 'online'; this.state.phaseEndsAt = this.state.sessionEndsAt; this.state.nextHumanBreakAt = now + tri(p.humanMinIntervalMinutes, p.humanMaxIntervalMinutes, this.random) * 60_000; }
          else this.beginSession(now, p);
          log.info(`pacing: back online${this.state.phase === 'online' ? ` until ${new Date(this.state.phaseEndsAt).toISOString()}` : ''}`);
        }
        break;
    }
    this.state.lastTickAt = now;
    this.save();
  }

  private beginSession(now: number, p: PacingSettings): void {
    const len = tri(p.minSessionMinutes, p.maxSessionMinutes, this.random) * 60_000;
    this.state.phase = 'online';
    this.state.phaseEndsAt = now + len;
    this.state.sessionEndsAt = now + len;
    this.state.nextHumanBreakAt = now + tri(p.humanMinIntervalMinutes, p.humanMaxIntervalMinutes, this.random) * 60_000;
    log.info(`pacing: session of ${Math.round(len / 60_000)} min`);
  }

  private async beginBreak(now: number, p: PacingSettings, why: string, until?: number): Promise<void> {
    const len = tri(p.minBreakMinutes, p.maxBreakMinutes, this.random) * 60_000;
    this.state.phase = 'break';
    this.state.phaseEndsAt = until ?? now + len;
    await this.service.pause(`pacing: ${why}, back at ${new Date(this.state.phaseEndsAt).toISOString()}`);
    log.info(`pacing: ${why}; offline for ${Math.round((this.state.phaseEndsAt - now) / 60_000)} min`);
  }

  private dayOf(ts: number): string { return new Date(ts).toISOString().slice(0, 10); }
  private nextMidnight(ts: number): number { const d = new Date(ts); d.setUTCHours(24, 0, 0, 0); return d.getTime(); }
  private save(): void { try { writeFileSync(this.file, JSON.stringify(this.state)); } catch { /* ignore */ } }
}

/** Triangular draw between min and max, peaked in the middle. */
export function tri(min: number, max: number, random: () => number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + (hi - lo) * (random() + random()) / 2;
}
