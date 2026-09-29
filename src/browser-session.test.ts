import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Browser } from 'playwright';
import {
  SESSION_CLOSE_TIMEOUT_MS,
  closeBrowserSessionWithTimeout,
  shouldRelaunchBrowserAfterError,
} from './browser-session.js';
import type { BrowserSession } from './browser.js';

describe('shouldRelaunchBrowserAfterError', () => {
  it('relaunches on Page crashed', () => {
    assert.equal(shouldRelaunchBrowserAfterError('Page crashed'), true);
  });

  it('relaunches on page.goto timeout', () => {
    assert.equal(
      shouldRelaunchBrowserAfterError('page.goto: Timeout 30000ms exceeded.'),
      true,
    );
  });

  it('does not relaunch on generic snapshot scrape errors', () => {
    assert.equal(shouldRelaunchBrowserAfterError('locator.count: Execution context was destroyed'), false);
  });
});

describe('closeBrowserSessionWithTimeout', () => {
  it('force-kills the browser when close hangs past the timeout', async () => {
    let killed = false;
    const browser = {
      process: () => ({
        pid: 42_424,
        killed: false,
        kill: (signal: string) => {
          if (signal === 'SIGKILL') killed = true;
        },
      }),
    } as unknown as Browser;

    const session: BrowserSession = {
      browser,
      context: {} as BrowserSession['context'],
      page: {} as BrowserSession['page'],
      close: () => new Promise(() => {
        // Never resolves — simulates hung Playwright shutdown.
      }),
    };

    const start = Date.now();
    await closeBrowserSessionWithTimeout(session, 80);
    const elapsed = Date.now() - start;

    assert.equal(killed, true);
    assert.ok(elapsed >= 70);
    assert.ok(elapsed < SESSION_CLOSE_TIMEOUT_MS);
  });
});

describe('closeBrowserSessionWithTimeout process tree', () => {
  it('kills the browser root and its own descendants (snapshot before root kill)', async () => {
    const { spawn } = await import('node:child_process');
    const { descendantPids } = await import('./browser-session.js');
    // root sh -> child sh -> grandchild sleep (mimics browser -> zygote -> renderer)
    const root = spawn('sh', ['-c', 'sh -c "sleep 60 & wait" & wait'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    const tree = await descendantPids(root.pid!);
    assert.ok(tree.length >= 2, `expected grandchildren, got ${tree.length}`);

    const browser = {
      process: () => ({
        pid: root.pid!,
        killed: false,
        kill: (signal: string) => root.kill(signal as NodeJS.Signals),
      }),
    } as unknown as Browser;
    const session: BrowserSession = {
      browser,
      context: {} as BrowserSession['context'],
      page: {} as BrowserSession['page'],
      close: () => new Promise(() => undefined),
    };
    await closeBrowserSessionWithTimeout(session, 50);
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of tree) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `descendant ${pid} survived`);
    }
  });
});
