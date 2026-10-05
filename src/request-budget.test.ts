import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  battleGapWaitMs,
  battleMinGapMs,
  claimBattleSlot,
  noteSharedThrottle,
  sharedLimiterEnabled,
  sharedThrottleRemainingMs,
  shouldBlockRequest,
  throttleRemainingMs,
} from './request-budget.js';

describe('round 9 request budget', () => {
  it('blocks fonts, media and analytics only', () => {
    assert.equal(shouldBlockRequest('font', 'https://web.idle-mmo.com/x.woff2'), true);
    assert.equal(shouldBlockRequest('media', 'https://cdn.idle-mmo.com/a.mp3'), true);
    assert.equal(shouldBlockRequest('script', 'https://www.googletagmanager.com/gtag/js'), true);
    assert.equal(shouldBlockRequest('image', 'https://cdn.idle-mmo.com/goblin.png'), false);
    assert.equal(shouldBlockRequest('fetch', 'https://web.idle-mmo.com/livewire/update'), false);
    assert.equal(shouldBlockRequest('document', 'https://web.idle-mmo.com/combat/battle'), false);
  });

  it('throttle window math', () => {
    assert.equal(throttleRemainingMs({ until: 1_000 }, 400), 600);
    assert.equal(throttleRemainingMs({ until: 1_000 }, 2_000), 0);
    assert.equal(throttleRemainingMs(undefined, 0), 0);
  });

  it('shared throttle file round-trips and never shortens a window', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rb-')), 'throttle.json');
    noteSharedThrottle(300_000, 'a', 1_000, path);
    assert.equal(sharedThrottleRemainingMs(1_000, path), 300_000);
    noteSharedThrottle(10_000, 'b', 2_000, path);
    assert.equal(sharedThrottleRemainingMs(2_000, path), 299_000);
  });

  it('battle gap math and env', () => {
    assert.equal(battleGapWaitMs({ at: 1_000 }, 5_000, 20_000), 16_000);
    assert.equal(battleGapWaitMs({ at: 1_000 }, 30_000, 20_000), 0);
    assert.equal(battleGapWaitMs(undefined, 0, 20_000), 0);
    assert.equal(battleMinGapMs({}), 120_000);
    assert.equal(battleMinGapMs({ BATTLE_MIN_GAP_MS: '5000' }), 5_000);
  });

  it('claimBattleSlot claims immediately when the gap has passed, honours maxWait', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rb-')), 'battle.json');
    writeFileSync(path, JSON.stringify({ at: Date.now() - 60_000 }));
    assert.ok((await claimBattleSlot('t', { path, gapMs: 20_000 })) < 100);
    const waited = await claimBattleSlot('t', { path, gapMs: 20_000, maxWaitMs: 50 });
    assert.ok(waited < 6_000);
  });

  it('is disabled under node:test for the default shared files', () => {
    assert.equal(sharedLimiterEnabled(), false);
    assert.equal(sharedLimiterEnabled({ SHARED_LIMITER: 'true' }), true);
    assert.equal(sharedLimiterEnabled({ SHARED_LIMITER: 'false' }), false);
  });
});
