import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { log } from '../util/log.js';

export interface ServiceStatus {
  /** systemd control is wired (sudoers rule + unit present). */
  available: boolean;
  /** The login switch: what the owner wants. The pacing scheduler only acts while this is on. */
  desired: 'on' | 'off';
  /** What systemd reports: active, inactive, activating, failed, unknown. */
  active: string;
  /** Why the service is currently stopped although desired is on (pacing break), if so. */
  pausedBy?: string;
  checkedAt: number;
  lastError?: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const defaultRunner: Runner = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => resolve({ stdout: String(stdout ?? ''), code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
});

/**
 * The login switch. Starts and stops the `skyflip-bot` systemd unit through
 * `sudo -n systemctl start|stop skyflip-bot` (a sudoers rule from deploy/install-bot.sh allows
 * exactly those two commands for the service user). The desired state is persisted so a backend
 * restart neither starts a bot the owner stopped nor forgets one they started.
 */
export class BotService extends EventEmitter {
  private readonly file: string;
  private desired: 'on' | 'off' = 'off';
  private active = 'unknown';
  private pausedBy?: string;
  private lastError?: string;
  private checkedAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(dataDir: string, private readonly unit = process.env.SKYFLIP_BOT_UNIT || 'skyflip-bot', private readonly run: Runner = defaultRunner, private readonly enabled = process.env.SKYFLIP_BOT_CONTROL !== 'none') {
    super();
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'bot-switch.json');
    if (existsSync(this.file)) { try { this.desired = JSON.parse(readFileSync(this.file, 'utf8')).desired === 'on' ? 'on' : 'off'; } catch { /* off */ } }
  }

  start(pollMs = 30_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), pollMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  status(): ServiceStatus {
    return { available: this.enabled, desired: this.desired, active: this.active, pausedBy: this.pausedBy, checkedAt: this.checkedAt, lastError: this.lastError };
  }

  /** Owner's switch. */
  async setDesired(on: boolean, reason = 'owner'): Promise<ServiceStatus> {
    this.desired = on ? 'on' : 'off';
    this.pausedBy = undefined;
    try { writeFileSync(this.file, JSON.stringify({ desired: this.desired, changedAt: Date.now(), reason })); } catch { /* ignore */ }
    log.info(`bot login switch ${this.desired} (${reason})`);
    if (on) await this.systemctl('start'); else await this.systemctl('stop');
    await this.refresh();
    return this.status();
  }

  /** Pacing scheduler: temporarily stop/start without touching the owner's switch. */
  async pause(by: string): Promise<void> {
    if (this.desired !== 'on') return;
    this.pausedBy = by;
    await this.systemctl('stop');
    await this.refresh();
  }
  async resume(): Promise<void> {
    if (this.desired !== 'on') return;
    this.pausedBy = undefined;
    await this.systemctl('start');
    await this.refresh();
  }

  async refresh(): Promise<ServiceStatus> {
    if (!this.enabled) { this.active = 'unavailable'; this.checkedAt = Date.now(); return this.status(); }
    const r = await this.run('systemctl', ['is-active', this.unit]).catch(() => ({ stdout: 'unknown', code: 1 }));
    const next = r.stdout.trim() || 'unknown';
    this.checkedAt = Date.now();
    if (next !== this.active) { this.active = next; this.emit('change', this.status()); }
    return this.status();
  }

  private async systemctl(verb: 'start' | 'stop'): Promise<void> {
    if (!this.enabled) { this.lastError = 'bot control disabled (SKYFLIP_BOT_CONTROL=none)'; return; }
    const r = await this.run('sudo', ['-n', 'systemctl', verb, this.unit]).catch((e) => ({ stdout: String(e), code: 1 }));
    if (r.code !== 0) { this.lastError = `systemctl ${verb} ${this.unit} failed (code ${r.code}); is the sudoers rule from deploy/install-bot.sh installed?`; log.warn(this.lastError); }
    else this.lastError = undefined;
  }
}
