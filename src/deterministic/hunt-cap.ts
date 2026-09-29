/**
 * Hard stop for hunting: battle once Total Enemies Found reaches this count.
 * Default is 100 (same batch size as coal / fish / cook). Override with HUNT_FOUND_CAP.
 * Combat level does not change the cap — Jev cannot hunt past it or battle before it.
 */
import type { EnemyInfo } from '../types.js';

export const DEFAULT_HUNT_FOUND_CAP = 100;

export function huntFoundCap(
  _combatLevel?: number | null,
  _totalLevel?: number | null,
): number {
  const raw = process.env.HUNT_FOUND_CAP?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_HUNT_FOUND_CAP;
}

/** Sum unfought enemy quantities on visible ENEMIES NEARBY tiles. */
export function enemyBacklogTotal(enemies: EnemyInfo[]): number {
  let total = 0;
  for (const enemy of enemies) {
    const qty = enemy.quantity;
    if (qty !== undefined && qty > 0) total += qty;
    else total += 1;
  }
  return total;
}

/** True when Total Enemies Found has hit the battle threshold — stop and battle. */
export function shouldHardStopHunt(
  found: number | null | undefined,
  combatLevel?: number | null,
  totalLevel?: number | null,
): boolean {
  return (found ?? 0) >= huntFoundCap(combatLevel, totalLevel);
}

/**
 * Skip Hunt More when the unfought tile backlog already meets the cap.
 * Cumulative Total Enemies Found can stay above the cap while a large stack remains.
 */
export function shouldSkipHuntMore(
  enemies: EnemyInfo[],
  combatLevel?: number | null,
  totalLevel?: number | null,
): boolean {
  if (enemies.length === 0) return false;
  return enemyBacklogTotal(enemies) >= huntFoundCap(combatLevel, totalLevel);
}
