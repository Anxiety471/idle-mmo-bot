import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CycleWatchdogTimeout, withCycleWatchdog } from './cycle-watchdog.js';

describe('withCycleWatchdog', () => {
  it('passes through a task that finishes in time', async () => {
    assert.equal(await withCycleWatchdog(Promise.resolve(7), 1_000, 'ok'), 7);
  });

  it('rejects a hung task after the limit and runs onTimeout once', async () => {
    let closed = 0;
    const never = new Promise<number>(() => undefined);
    await assert.rejects(
      withCycleWatchdog(never, 50, 'hung', async () => {
        closed += 1;
      }),
      (err: unknown) => err instanceof CycleWatchdogTimeout && err.label === 'hung',
    );
    assert.equal(closed, 1);
  });

  it('does not leave an unhandled rejection when the hung task fails after timeout', async () => {
    let rejectLater: (e: Error) => void = () => undefined;
    const late = new Promise<number>((_, reject) => {
      rejectLater = reject;
    });
    await assert.rejects(withCycleWatchdog(late, 20, 'late'));
    rejectLater(new Error('Target page, context or browser has been closed'));
    await new Promise((r) => setTimeout(r, 10));
  });

  it('fires the no-progress check before the hard cap', async () => {
    let closed = 0;
    const never = new Promise<number>(() => undefined);
    const started = Date.now();
    await assert.rejects(
      withCycleWatchdog(
        never,
        60_000,
        'frozen',
        async () => {
          closed += 1;
        },
        { limitMs: 30, sinceProgress: () => Date.now() - started, checkMs: 10 },
      ),
      (err: unknown) => err instanceof CycleWatchdogTimeout && err.label === 'frozen',
    );
    assert.equal(closed, 1);
  });

  it('does not fire while progress keeps being made', async () => {
    const done = new Promise<number>((r) => setTimeout(() => r(3), 80));
    const v = await withCycleWatchdog(done, 60_000, 'busy', async () => undefined, {
      limitMs: 30,
      sinceProgress: () => 0,
      checkMs: 10,
    });
    assert.equal(v, 3);
  });
});
