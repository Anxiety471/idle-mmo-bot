import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  actionSleepMaxMs,
  fallbackPollMs,
  parseCurrentActionRemainingMs,
  planSleep,
  randomBufferMs,
  resetTimerReadForTest,
  trustTimerRead,
  timedSleepEnabled,
} from './action-timer.js';
import { sellSweepIntervalMs } from './early-systems-playbook.js';

describe('round 10 timed sleep', () => {
  it('parses the CURRENT ACTION countdown, ignoring "Next item in"', () => {
    const text = 'CURRENT ACTION\n02:55:37\nCoal Ore\n+877\nNext item in 0:05\n0.23 EXP/s';
    assert.equal(parseCurrentActionRemainingMs(text), (2 * 3600 + 55 * 60 + 37) * 1000);
    assert.equal(parseCurrentActionRemainingMs('CURRENT ACTION\n12:04\nCod\nNext item in 0:06'), (12 * 60 + 4) * 1000);
    assert.equal(parseCurrentActionRemainingMs('CURRENT ACTION\nCod\nNext item in 0:06'), undefined);
    assert.equal(parseCurrentActionRemainingMs('no panel 01:00:00'), undefined);
  });

  it('fallback poll defaults to 5 min and is clamped', () => {
    assert.equal(fallbackPollMs({}), 300_000);
    assert.equal(fallbackPollMs({ FALLBACK_POLL_MS: '600000' }), 600_000);
    assert.equal(fallbackPollMs({ FALLBACK_POLL_MS: '1000' }), 60_000);
    assert.equal(actionSleepMaxMs({}), 3 * 3_600_000);
    assert.equal(timedSleepEnabled({}), true);
    assert.equal(timedSleepEnabled({ TIMED_SLEEP: 'false' }), false);
  });

  it('buffer is 10–60 s', () => {
    assert.equal(randomBufferMs(() => 0, {}), 10_000);
    assert.equal(randomBufferMs(() => 1, {}), 60_000);
  });

  it('plans timer + buffer, backoff, or fallback', () => {
    assert.deepEqual(planSleep({ timerMs: 600_000 }, () => 0, {}), { sleepMs: 610_000, source: 'timer', timerMs: 600_000 });
    assert.equal(planSleep({ timerMs: 20 * 3_600_000 }, () => 0, {}).sleepMs, 3 * 3_600_000);
    assert.deepEqual(planSleep({}, () => 0, {}), { sleepMs: 300_000, source: 'fallback' });
    assert.deepEqual(planSleep({ backoffMs: 900_000 }, () => 0, {}), { sleepMs: 900_000, source: 'backoff' });
    assert.equal(planSleep({ backoffMs: 900_000, timerMs: 60_000 }, () => 0, {}).source, 'backoff');
    assert.equal(planSleep({ backoffMs: 60_000, timerMs: 600_000 }, () => 0, {}).source, 'timer');
  });

  it('sell sweep interval: default 30 min, never below 30 min', () => {
    assert.equal(sellSweepIntervalMs({}), 1_800_000);
    assert.equal(sellSweepIntervalMs({ SELL_SWEEP_INTERVAL_MS: '3600000' }), 3_600_000);
    assert.equal(sellSweepIntervalMs({ SELL_SWEEP_INTERVAL_MS: '60000' }), 1_800_000);
    assert.equal(sellSweepIntervalMs({ SELL_RETRY_COOLDOWN_MS: '7200000' }), 7_200_000);
  });

  it('distrusts a timer that grows while the same action continues', () => {
    resetTimerReadForTest();
    assert.equal(trustTimerRead('fish_cod', 600_000, 0), true);
    assert.equal(trustTimerRead('continue_current', 300_000, 300_000), true);
    assert.equal(trustTimerRead('continue_current', 900_000, 600_000), false);
    assert.equal(trustTimerRead('cook_cod', 900_000, 700_000), true);
    assert.equal(trustTimerRead('continue_current', undefined, 800_000), false);
  });
});
