/**
 * Process liveness: a monotonic "last progress" mark (bumped on every console line and
 * explicitly by the loop), a wall-vs-monotonic suspend/resume detector, and a per-bot
 * heartbeat file so overseers can tell a box suspend from a real hang.
 *
 * Round 6: both cross-bot "stalls" (Sep 30 10:54→12:56, Oct 1 02:51→03:57) were the whole
 * sandbox VM being paused — /proc/uptime lost ~59 min and the sandbox fuse/host relaunched
 * at the resume instant. Node timers run on the monotonic clock, so no in-process watchdog
 * can fire during a suspend; this module makes the suspend visible instead.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let lastProgressMono = performance.now();
let lastProgressWall = Date.now();
let hooked = false;

export function markProgress(): void {
  lastProgressMono = performance.now();
  lastProgressWall = Date.now();
}

/** Milliseconds (monotonic) since the last progress mark. */
export function msSinceProgress(nowMono = performance.now()): number {
  return nowMono - lastProgressMono;
}

export function lastProgressWallMs(): number {
  return lastProgressWall;
}

/** Every console.log / warn / error counts as progress (hunt poll, battle monitor, captcha all log ≤ ~30 s). */
export function installConsoleProgressHook(): void {
  if (hooked) return;
  hooked = true;
  for (const method of ['log', 'warn', 'error', 'info'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      markProgress();
      original(...args);
    };
  }
}

/** Env-configurable no-progress limit (default 20 min). 0 disables. */
export function noProgressWatchdogMs(): number {
  const raw = process.env.NO_PROGRESS_WATCHDOG_MS;
  if (raw === undefined || raw === '') return 20 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20 * 60_000;
}

/**
 * Pure: how long the process was suspended between two samples. Wall clock advances during
 * a VM pause; the monotonic clock does not. Returns 0 below the threshold.
 */
export function detectSuspendMs(
  prev: { wall: number; mono: number },
  now: { wall: number; mono: number },
  thresholdMs = 60_000,
): number {
  const gap = now.wall - prev.wall - (now.mono - prev.mono);
  return gap > thresholdMs ? gap : 0;
}

export interface HeartbeatState {
  pid: number;
  cycle: number;
  lastTickAt: string;
  lastProgressAt: string;
  lastResume?: { at: string; suspendedMs: number };
  /** Round 10: planned wake time while sleeping until the running action ends. */
  sleepUntil?: string;
  sleepSource?: string;
  sleepTimerMs?: number;
}

let heartbeat: HeartbeatState = {
  pid: process.pid,
  cycle: 0,
  lastTickAt: new Date().toISOString(),
  lastProgressAt: new Date().toISOString(),
};

export function writeHeartbeat(logDir: string, patch: Partial<HeartbeatState> = {}): void {
  heartbeat = {
    ...heartbeat,
    ...patch,
    pid: process.pid,
    lastTickAt: new Date().toISOString(),
    lastProgressAt: new Date(lastProgressWall).toISOString(),
  };
  try {
    mkdirSync(logDir, { recursive: true });
    const file = join(logDir, 'heartbeat.json');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(heartbeat, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // heartbeat is best-effort
  }
}

/** Start the resume detector + heartbeat ticker. Returns a stop function. */
export function startLivenessMonitor(logDir: string, intervalMs = 15_000): () => void {
  let prev = { wall: Date.now(), mono: performance.now() };
  const timer = setInterval(() => {
    const now = { wall: Date.now(), mono: performance.now() };
    const suspended = detectSuspendMs(prev, now);
    prev = now;
    if (suspended > 0) {
      const mins = Math.round(suspended / 60_000);
      console.log(
        `[autopilot] box resume detected: process was suspended ~${mins} min (wall clock jumped, monotonic did not) — not a bot hang`,
      );
      writeHeartbeat(logDir, {
        lastResume: { at: new Date(now.wall).toISOString(), suspendedMs: Math.round(suspended) },
      });
      return;
    }
    writeHeartbeat(logDir);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
