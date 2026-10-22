import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PacingScheduler, tri } from '../bot/pacing.js';
import { SettingsStore } from '../flips/settings.js';

class FakeService {
  desired: 'on' | 'off' = 'on';
  pausedBy?: string;
  calls: string[] = [];
  status() { return { desired: this.desired, pausedBy: this.pausedBy }; }
  async pause(by: string) { this.pausedBy = by; this.calls.push('pause'); }
  async resume() { this.pausedBy = undefined; this.calls.push('resume'); }
}

test('tri stays within bounds', () => {
  for (const r of [0, 0.5, 1]) { const v = tri(10, 20, () => r); assert.ok(v >= 10 && v <= 20); }
  assert.equal(tri(10, 20, () => 0.5), 15);
});

test('pacing runs sessions, breaks, daily cap, and stays idle when disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-pacing-'));
  const settings = new SettingsStore(dir);
  const svc = new FakeService();
  let now = Date.parse('2026-10-21T00:30:00Z');
  const p = new PacingScheduler(settings, svc, dir, { now: () => now, random: () => 0.5 });
  await p.tick();
  assert.equal(p.status().phase, 'off');
  assert.deepEqual(svc.calls, []);
  // enable: session of (60+300)/2 = 180 min, break (30+180)/2 = 105 min, cap 600 min/day
  settings.update({ pacing: { ...settings.current.pacing, enabled: true } });
  await p.tick();
  assert.equal(p.status().phase, 'online');
  now += 179 * 60_000; await p.tick();
  assert.equal(p.status().phase, 'online');
  now += 2 * 60_000; await p.tick();
  assert.equal(p.status().phase, 'break');
  assert.deepEqual(svc.calls, ['pause']);
  assert.match(svc.pausedBy!, /pacing: session over/);
  now += 104 * 60_000; await p.tick();
  assert.equal(p.status().phase, 'break');
  now += 2 * 60_000; await p.tick();
  assert.equal(p.status().phase, 'online');
  assert.deepEqual(svc.calls, ['pause', 'resume']);
  // persisted state survives a new scheduler
  const p2 = new PacingScheduler(settings, svc, dir, { now: () => now, random: () => 0.5 });
  assert.equal(p2.status().phase, 'online');
  assert.ok(p2.status().onlineMsToday >= 181 * 60_000);
  // daily cap: 600 min total → after this session plus most of another we hit it
  for (let i = 0; i < 30; i++) { now += 30 * 60_000; await p.tick(); }
  assert.ok(p.status().onlineMsToday >= 600 * 60_000 - 1);
  assert.equal(p.status().phase, 'break');
  assert.match(svc.pausedBy!, /daily allowance/);
  // next day: back online
  now = Date.parse('2026-10-22T00:00:30Z'); await p.tick();
  assert.equal(p.status().onlineMsToday, 0);
  now += 60_000; await p.tick();
  assert.equal(p.status().phase, 'online');
  // owner turns the switch off: the scheduler lets go and reports off
  svc.desired = 'off'; svc.pausedBy = undefined;
  const callsBefore = svc.calls.length;
  await p.tick();
  assert.equal(p.status().phase, 'off');
  assert.equal(svc.calls.length, callsBefore, 'nothing to resume: the owner turned it off');
});

test('humanization inserts short breaks and resumes the same session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-pacing-'));
  const settings = new SettingsStore(dir);
  settings.update({ pacing: { ...settings.current.pacing, enabled: true, humanize: true, minSessionMinutes: 600, maxSessionMinutes: 600, humanMinIntervalMinutes: 10, humanMaxIntervalMinutes: 10, humanMinBreakMinutes: 2, humanMaxBreakMinutes: 2, dailyOnlineMinutes: 0 } });
  const svc = new FakeService();
  let now = Date.parse('2026-10-21T10:00:00Z');
  const p = new PacingScheduler(settings, svc, dir, { now: () => now, random: () => 0.5 });
  await p.tick();
  assert.equal(p.status().phase, 'online');
  now += 11 * 60_000; await p.tick();
  assert.equal(p.status().phase, 'human-break');
  assert.match(svc.pausedBy!, /short break/);
  now += 3 * 60_000; await p.tick();
  assert.equal(p.status().phase, 'online');
  assert.ok(p.status().phaseEndsAt > now + 500 * 60_000, 'session end unchanged by the short break');
});
