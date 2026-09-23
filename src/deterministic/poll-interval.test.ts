import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_VERIFY_ATTEMPTS_PER_CYCLE,
  canAttemptVerify,
  createVerifyBudget,
  effectivePollMs,
  recordVerifyAttempt,
  verifyBackoffMs,
} from './poll-interval.js';

describe('effectivePollMs', () => {
  it('floors sub-second values to MIN_POLL_MS', () => {
    assert.equal(effectivePollMs(100), 2000);
    assert.equal(effectivePollMs(500), 2000);
    assert.equal(effectivePollMs(0), 5000);
    assert.equal(effectivePollMs(-1), 5000);
  });

  it('passes through values at or above MIN_POLL_MS', () => {
    assert.equal(effectivePollMs(2000), 2000);
    assert.equal(effectivePollMs(5000), 5000);
    assert.equal(effectivePollMs(25_000), 25_000);
  });

  it('defaults when pollMs is undefined', () => {
    assert.equal(effectivePollMs(undefined), 5000);
  });
});

describe('verifyBackoffMs', () => {
  it('scales with poll interval and has a 30s floor', () => {
    assert.equal(verifyBackoffMs(5000), 30_000);
    assert.equal(verifyBackoffMs(2000), 30_000);
    assert.equal(verifyBackoffMs(10_000), 60_000);
  });
});

describe('verify budget', () => {
  it('allows one attempt per combat cycle', () => {
    const budget = createVerifyBudget();
    assert.equal(MAX_VERIFY_ATTEMPTS_PER_CYCLE, 1);
    assert.equal(canAttemptVerify(budget), true);
    recordVerifyAttempt(budget);
    assert.equal(canAttemptVerify(budget), false);
    recordVerifyAttempt(budget);
    assert.equal(canAttemptVerify(budget), false);
  });
});
