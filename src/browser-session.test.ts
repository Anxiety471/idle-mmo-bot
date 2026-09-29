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
