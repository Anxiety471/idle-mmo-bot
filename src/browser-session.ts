import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

/** Direct children of a PID (own tree only — never matches by process name). */
async function childPids(pid: number): Promise<number[]> {
  if (!pid) return [];
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    return stdout
      .trim()
      .split('\n')
      .map((line) => Number.parseInt(line, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * All descendants of the browser root. Chromium renderers hang off a zygote,
 * so direct children alone miss them.
 */
export async function descendantPids(pid: number, depth = 0): Promise<number[]> {
  if (!pid || depth > 6) return [];
  const out: number[] = [];
  for (const child of await childPids(pid)) {
    out.push(child, ...(await descendantPids(child, depth + 1)));
  }
  return out;
}

async function isRendererProcess(pid: number): Promise<boolean> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('--type=renderer');
  } catch {
    return false;
  }
}

/** Count renderer processes in the browser's own process tree. */
export async function countChildProcesses(pid: number): Promise<number> {
  const pids = await descendantPids(pid);
  let renderers = 0;
  for (const p of pids) {
    if (await isRendererProcess(p)) renderers++;
  }
  return renderers;
}

/** RSS summed over the browser root and its descendants. */
async function readTreeRssBytes(pid: number): Promise<number | undefined> {
  const pids = [pid, ...(await descendantPids(pid))];
  let total = 0;
  let any = false;
  for (const p of pids) {
    const rss = await readProcessRssBytes(p);
    if (rss !== undefined) {
      total += rss;
      any = true;
    }
  }
  return any ? total : undefined;
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

  const rss = await readTreeRssBytes(pid);
  if (rss !== undefined && rss >= BROWSER_RECYCLE_MAX_RSS_BYTES) {
    return { recycle: true, reason: `rss ${Math.round(rss / (1024 * 1024))}MB` };
  }

  const children = await countChildProcesses(pid);
  if (children >= BROWSER_RECYCLE_MAX_RENDERERS) {
    return { recycle: true, reason: `renderer processes ${children}` };
  }

  return { recycle: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forceKillBrowserProcess(browser: Browser): Promise<void> {
  const proc = browserProcess(browser);
  if (!proc?.pid) return;
  // Snapshot this browser's own tree BEFORE killing the root: once the root dies,
  // its children reparent and `pgrep -P root` can no longer find them.
  const tree = await descendantPids(proc.pid).catch(() => [] as number[]);
  if (!proc.killed) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Process may already be gone.
    }
  }
  for (const pid of tree) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
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
