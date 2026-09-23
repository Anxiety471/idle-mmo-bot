import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { HuntState } from '../types.js';
import { readHuntState } from '../deterministic/combat.js';
import { effectivePollMs } from '../deterministic/poll-interval.js';
import type { JevAdvisor } from './types.js';

/** Effective combat level for cap scaling (fallback when combat is 0/missing). */
export function effectiveCombatLevel(combatLevel?: number, totalLevel?: number): number {
  if (combatLevel !== undefined && combatLevel > 0) return combatLevel;
  if (totalLevel !== undefined && totalLevel > 0) {
    return Math.max(1, Math.ceil(totalLevel / 10));
  }
  return 1;
}

/**
 * Hard max Total Enemies Found before stop — scales with stats, absolute max 10.
 * combat 1 → cap 1; combat 20 → cap 10.
 */
export function huntFoundCap(combatLevel?: number, totalLevel?: number): number {
  const combat = effectiveCombatLevel(combatLevel, totalLevel);
  return Math.min(10, Math.max(1, Math.ceil(combat / 2)));
}

export function withHuntLevels(
  state: HuntState,
  combatLevel?: number,
  totalLevel?: number,
): HuntState {
  return { ...state, combatLevel, totalLevel };
}

/** Hard stop: Jev cannot override when found >= cap. */
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
 * Poll hunt metrics until hard cap or Jev says stop.
 * Hard cap is checked before every Jev call and cannot be overridden.
 */
export async function pollUntilHuntStop(
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
  initialState: HuntState,
  levels: HuntLevelContext = {},
): Promise<HuntState> {
  const cap = huntFoundCap(levels.combatLevel, levels.totalLevel);
  const pollMs = effectivePollMs(config.pollMs);
  let huntState = withHuntLevels(initialState, levels.combatLevel, levels.totalLevel);
  const maxZeroFoundPolls = Math.max(40, Math.ceil(120_000 / pollMs));
  let zeroFoundPolls = 0;

  while (true) {
    const found = huntState.totalEnemiesFound ?? 0;
    if (found >= cap) {
      console.log(`[combat] hard stop: found=${found} >= cap=${cap} (combat=${levels.combatLevel ?? '?'})`);
      break;
    }
    if (await jev.decideHuntStop(huntState)) {
      break;
    }
    zeroFoundPolls = found === 0 ? zeroFoundPolls + 1 : 0;
    if (zeroFoundPolls >= maxZeroFoundPolls) {
      console.log(
        `[combat] hunt metrics still 0 after ${zeroFoundPolls} polls — stopping poll loop (scrape or hunt may be stuck)`,
      );
      break;
    }
    await sleep(pollMs);
    huntState = withHuntLevels(await readHuntState(page), levels.combatLevel, levels.totalLevel);
  }

  return huntState;
}
