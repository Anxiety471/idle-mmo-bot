import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { HuntState } from '../types.js';
import { readHuntState } from '../deterministic/combat.js';
import { enemyBacklogTotal, huntFoundCap, shouldSkipHuntMore } from '../deterministic/hunt-cap.js';

export { enemyBacklogTotal, shouldSkipHuntMore } from '../deterministic/hunt-cap.js';
import { effectivePollMs } from '../deterministic/poll-interval.js';
import type { JevAdvisor } from './types.js';

export { huntFoundCap } from '../deterministic/hunt-cap.js';

export function withHuntLevels(
  state: HuntState,
  combatLevel?: number,
  totalLevel?: number,
): HuntState {
  return { ...state, combatLevel, totalLevel };
}

/**
 * Hard stop from the hunt panel's Total Enemies Found counter.
 * Default cap is 100. A large Enemies Remaining value does not delay battle.
 */
export function isHuntHardStop(state: HuntState): boolean {
  const cap = huntFoundCap(state.combatLevel, state.totalLevel);
  return (state.totalEnemiesFound ?? 0) >= cap;
}

export interface HuntLevelContext {
  combatLevel?: number;
  totalLevel?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the hunt panel until Total Enemies Found reaches the cap (default 100), then battle.
 * Jev cannot stop early and cannot keep hunting past the cap. Enemies Remaining is ignored.
 * `jev` stays on the signature so callers do not change; the found counter is the trigger.
 */
function envPositiveMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Hard wall-clock bound for one hunt poll loop (default 60 min). */
export function huntPollMaxMs(): number {
  return envPositiveMs('HUNT_POLL_MAX_MS', 60 * 60_000);
}

/** Found count unchanged this long means the page/hunt is stuck (default 15 min). */
export function huntPollStaleMs(): number {
  return envPositiveMs('HUNT_POLL_STALE_MS', 15 * 60_000);
}

export function huntPollBoundReached(args: {
  found: number;
  startedAt: number;
  lastChangeAt: number;
  now: number;
  maxMs: number;
  staleMs: number;
}): 'wall_clock' | 'stale' | null {
  if (args.now - args.startedAt > args.maxMs) return 'wall_clock';
  if (args.found > 0 && args.now - args.lastChangeAt > args.staleMs) return 'stale';
  return null;
}

export async function pollUntilHuntStop(
  page: Page,
  config: AppConfig,
  _jev: JevAdvisor,
  initialState: HuntState,
  levels: HuntLevelContext = {},
): Promise<HuntState> {
  const cap = huntFoundCap(levels.combatLevel, levels.totalLevel);
  const pollMs = effectivePollMs(config.pollMs);
  let huntState = withHuntLevels(initialState, levels.combatLevel, levels.totalLevel);
  const maxZeroFoundPolls = Math.max(40, Math.ceil(120_000 / pollMs));
  let zeroFoundPolls = 0;
  const startedAt = Date.now();
  const maxPollMs = huntPollMaxMs();
  const staleLimitMs = huntPollStaleMs();
  let lastFound = huntState.totalEnemiesFound ?? 0;
  let lastChangeAt = Date.now();

  while (true) {
    const found = huntState.totalEnemiesFound ?? 0;
    if (found >= cap) {
      console.log(
        `[combat] battle now: Total Enemies Found=${found} >= cap=${cap}` +
          ` (remaining=${huntState.enemiesRemaining ?? '?'})`,
      );
      break;
    }
    zeroFoundPolls = found === 0 ? zeroFoundPolls + 1 : 0;
    if (zeroFoundPolls >= maxZeroFoundPolls) {
      console.log(
        `[combat] Total Enemies Found still 0 after ${zeroFoundPolls} polls — stopping poll loop (scrape or hunt may be stuck)`,
      );
      break;
    }
    if (found !== lastFound) {
      lastFound = found;
      lastChangeAt = Date.now();
    }
    const bound = huntPollBoundReached({
      found,
      startedAt,
      lastChangeAt,
      now: Date.now(),
      maxMs: maxPollMs,
      staleMs: staleLimitMs,
    });
    if (bound === 'wall_clock') {
      console.log(
        `[combat] hunt poll wall-clock ${Math.round(maxPollMs / 60_000)} min reached at Found=${found}/${cap} — stopping poll loop`,
      );
      break;
    }
    if (bound === 'stale') {
      console.log(
        `[combat] Total Enemies Found stuck at ${found} for ${Math.round(staleLimitMs / 60_000)} min — stopping poll loop`,
      );
      break;
    }
    console.log(`[combat] hunting: Total Enemies Found=${found}/${cap} — keep hunting`);
    await sleep(pollMs);
    huntState = withHuntLevels(await readHuntState(page), levels.combatLevel, levels.totalLevel);
  }

  return huntState;
}
