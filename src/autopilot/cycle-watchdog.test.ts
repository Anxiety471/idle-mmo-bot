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
});
