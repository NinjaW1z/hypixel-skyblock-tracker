import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotService } from '../bot/service.js';

test('login switch drives systemctl through sudo and persists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-svc-'));
  const calls: string[] = [];
  let active = 'inactive';
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'sudo') { active = args[2] === 'start' ? 'active' : 'inactive'; return { stdout: '', code: 0 }; }
    return { stdout: active + '\n', code: active === 'active' ? 0 : 3 };
  };
  const s = new BotService(dir, 'skyflip-bot', run, true);
  assert.equal(s.status().desired, 'off');
  let st = await s.setDesired(true);
  assert.equal(st.desired, 'on'); assert.equal(st.active, 'active');
  assert.deepEqual(calls, ['sudo -n systemctl start skyflip-bot', 'systemctl is-active skyflip-bot']);
  await s.pause('pacing: test');
  assert.equal(s.status().active, 'inactive'); assert.equal(s.status().pausedBy, 'pacing: test'); assert.equal(s.status().desired, 'on');
  await s.resume();
  assert.equal(s.status().active, 'active'); assert.equal(s.status().pausedBy, undefined);
  st = await s.setDesired(false);
  assert.equal(st.active, 'inactive');
  const s2 = new BotService(dir, 'skyflip-bot', run, true);
  assert.equal(s2.status().desired, 'off');
  await s2.pause('pacing'); // ignored while desired is off
  assert.ok(!calls[calls.length - 1].includes('stop') || calls.filter((c) => c.includes('stop')).length === 1);
});

test('failed sudo is reported, not thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skyflip-svc-'));
  const run = async (cmd: string) => (cmd === 'sudo' ? { stdout: '', code: 1 } : { stdout: 'inactive', code: 3 });
  const s = new BotService(dir, 'skyflip-bot', run, true);
  const st = await s.setDesired(true);
  assert.match(st.lastError!, /sudoers/);
  assert.equal(st.desired, 'on');
});
