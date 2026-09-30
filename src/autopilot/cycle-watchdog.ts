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

/** One action budget: hunt poll (bounded at HUNT_POLL_MAX_MS, 60 min) + battle + slack. */
export function executeWatchdogMs(): number {
  return envMs('CYCLE_EXECUTE_WATCHDOG_MS', 90 * 60_000);
}

export async function withCycleWatchdog<T>(
  task: Promise<T>,
  limitMs: number,
  label: string,
  onTimeout: () => Promise<void> = async () => undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.error(`[autopilot] cycle watchdog fired: ${label} > ${Math.round(limitMs / 1000)}s`);
      void onTimeout()
        .catch(() => undefined)
        .finally(() => reject(new CycleWatchdogTimeout(label, limitMs)));
    }, limitMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // The hung task may reject later (browser closed) — never leave it unhandled.
    task.catch(() => undefined);
  }
}
