/**
 * Per-cycle watchdog: a single snapshot or action must not hang the supervisor forever
 * (an unbounded Playwright await, a stuck poll loop, a wedged browser).
 *
 * On timeout the caller-supplied onTimeout runs (the autopilot closes the browser session,
 * which rejects every pending Playwright await in the hung task), then the race rejects
 * with CycleWatchdogTimeout so the loop relaunches the browser and carries on.
 */
export class CycleWatchdogTimeout extends Error {
  constructor(
    readonly label: string,
    readonly limitMs: number,
  ) {
    super(`cycle watchdog: ${label} exceeded ${Math.round(limitMs / 1000)}s`);
    this.name = 'CycleWatchdogTimeout';
  }
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Snapshot + discovery budget (normal ~10–35 s, slow server ~60 s). */
export function snapshotWatchdogMs(): number {
  return envMs('CYCLE_SNAPSHOT_WATCHDOG_MS', 8 * 60_000);
}

/**
 * One action budget. Worst legitimate hunt_battle_batch cycle: hunt poll (HUNT_POLL_MAX_MS,
 * 60 min) + battle monitor (up to 4 × 15 min = 60 min) + snapshot/verify slack.
 */
export function executeWatchdogMs(): number {
  return envMs('CYCLE_EXECUTE_WATCHDOG_MS', 150 * 60_000);
}

export interface NoProgressOptions {
  /** No-progress limit (monotonic ms); 0/undefined disables. */
  limitMs?: number;
  /** Returns ms since the last progress mark. */
  sinceProgress?: () => number;
  /** Check interval (default 15 s). */
  checkMs?: number;
}

export async function withCycleWatchdog<T>(
  task: Promise<T>,
  limitMs: number,
  label: string,
  onTimeout: () => Promise<void> = async () => undefined,
  noProgress: NoProgressOptions = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checker: ReturnType<typeof setInterval> | undefined;
  let fired = false;
  const timeout = new Promise<never>((_, reject) => {
    const fire = (why: string, limit: number) => {
      if (fired) return;
      fired = true;
      if (timer) clearTimeout(timer);
      if (checker) clearInterval(checker);
      console.error(`[autopilot] cycle watchdog fired: ${label} ${why}`);
      void onTimeout()
        .catch(() => undefined)
        .finally(() => reject(new CycleWatchdogTimeout(label, limit)));
    };
    timer = setTimeout(() => fire(`> ${Math.round(limitMs / 1000)}s`, limitMs), limitMs);
    const npLimit = noProgress.limitMs ?? 0;
    const since = noProgress.sinceProgress;
    if (npLimit > 0 && since) {
      checker = setInterval(() => {
        const idle = since();
        if (idle > npLimit) {
          fire(`no progress for ${Math.round(idle / 1000)}s (limit ${Math.round(npLimit / 1000)}s)`, npLimit);
        }
      }, noProgress.checkMs ?? 15_000);
    }
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (checker) clearInterval(checker);
    // The hung task may reject later (browser closed) — never leave it unhandled.
    task.catch(() => undefined);
  }
}
