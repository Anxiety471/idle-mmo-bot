import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectSuspendMs, noProgressWatchdogMs, writeHeartbeat } from './liveness.js';

describe('detectSuspendMs', () => {
  it('flags a wall-clock jump the monotonic clock did not see (VM pause)', () => {
    const gap = detectSuspendMs({ wall: 0, mono: 0 }, { wall: 59 * 60_000 + 15_000, mono: 15_000 });
    assert.equal(gap, 59 * 60_000);
  });

  it('ignores normal ticks and small jitter', () => {
    assert.equal(detectSuspendMs({ wall: 0, mono: 0 }, { wall: 15_500, mono: 15_000 }), 0);
  });
});

describe('noProgressWatchdogMs', () => {
  it('defaults to 20 min and honours the env override', () => {
    const prev = process.env.NO_PROGRESS_WATCHDOG_MS;
    delete process.env.NO_PROGRESS_WATCHDOG_MS;
    assert.equal(noProgressWatchdogMs(), 20 * 60_000);
    process.env.NO_PROGRESS_WATCHDOG_MS = '0';
    assert.equal(noProgressWatchdogMs(), 0);
    if (prev === undefined) delete process.env.NO_PROGRESS_WATCHDOG_MS;
    else process.env.NO_PROGRESS_WATCHDOG_MS = prev;
  });
});

describe('writeHeartbeat', () => {
  it('writes pid, cycle and resume info atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'));
    writeHeartbeat(dir, { cycle: 7, lastResume: { at: '2026-10-01T00:00:00.000Z', suspendedMs: 60_000 } });
    const hb = JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8'));
    assert.equal(hb.pid, process.pid);
    assert.equal(hb.cycle, 7);
    assert.equal(hb.lastResume.suspendedMs, 60_000);
  });
});
