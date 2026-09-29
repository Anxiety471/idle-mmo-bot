import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser } from 'playwright';
import type { BrowserSession } from './browser.js';

const execFileAsync = promisify(execFile);

type BrowserProcess = { pid: number; killed: boolean; kill: (signal?: string) => void };

function browserProcess(browser: Browser): BrowserProcess | null {
  const proc = (browser as Browser & { process?: () => BrowserProcess | null }).process?.();
  return proc ?? null;
}

/** Wall-clock cap for graceful Playwright shutdown before SIGKILL. */
export const SESSION_CLOSE_TIMEOUT_MS = 15_000;

export const BROWSER_RECYCLE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const BROWSER_RECYCLE_MAX_RSS_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
export const BROWSER_RECYCLE_MAX_RENDERERS = 10;

const CRASH_RELAUNCH_PATTERN =
  /Page crashed|Target crashed|Target closed|Timeout\s+\d+ms exceeded.*goto|page\.goto:\s*Timeout/i;

/** Whether autopilot should tear down and relaunch Chromium after this error. */
export function shouldRelaunchBrowserAfterError(message: string): boolean {
  return CRASH_RELAUNCH_PATTERN.test(message);
}

export async function readProcessRssBytes(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const kb = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(kb) || kb <= 0) return undefined;
    return kb * 1024;
  } catch {
    return undefined;
  }
}

/** Count child processes of the browser root (renderer / utility processes). */
export async function countChildProcesses(pid: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.length;
  } catch {
    return 0;
  }
}

export interface BrowserRecycleProbe {
  launchedAtMs: number;
  browser: Browser;
}

export async function shouldProactivelyRecycleBrowser(
  probe: BrowserRecycleProbe,
): Promise<{ recycle: boolean; reason?: string }> {
  const ageMs = Date.now() - probe.launchedAtMs;
  if (ageMs >= BROWSER_RECYCLE_MAX_AGE_MS) {
    return { recycle: true, reason: `age ${Math.round(ageMs / 60_000)}m` };
  }

  const pid = browserProcess(probe.browser)?.pid;
  if (!pid) return { recycle: false };

  const rss = await readProcessRssBytes(pid);
  if (rss !== undefined && rss >= BROWSER_RECYCLE_MAX_RSS_BYTES) {
    return { recycle: true, reason: `rss ${Math.round(rss / (1024 * 1024))}MB` };
  }

  const children = await countChildProcesses(pid);
  if (children >= BROWSER_RECYCLE_MAX_RENDERERS) {
    return { recycle: true, reason: `child processes ${children}` };
  }

  return { recycle: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forceKillBrowserProcess(browser: Browser): Promise<void> {
  const proc = browserProcess(browser);
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    // Process may already be gone.
  }
  try {
    const children = await countChildProcesses(proc.pid ?? 0);
    if (proc.pid && children > 0) {
      await execFileAsync('pkill', ['-9', '-P', String(proc.pid)]).catch(() => undefined);
    }
  } catch {
    // Best-effort child cleanup.
  }
}

/**
 * Close Playwright session with a timeout; SIGKILL the browser if close hangs
 * (snapshot failures used to block forever on context.close()).
 */
export async function closeBrowserSessionWithTimeout(
  session: BrowserSession,
  timeoutMs = SESSION_CLOSE_TIMEOUT_MS,
): Promise<void> {
  let closed = false;
  const closePromise = session
    .close()
    .then(() => {
      closed = true;
    })
    .catch(() => {
      closed = true;
    });

  const timer = sleep(timeoutMs).then(async () => {
    if (!closed) {
      await forceKillBrowserProcess(session.browser);
    }
  });

  await Promise.race([closePromise, timer]);
  if (!closed) {
    await forceKillBrowserProcess(session.browser);
  }
}
