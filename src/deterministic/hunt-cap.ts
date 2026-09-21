/**
 * Hard stop for hunting: Total Enemies Found must not exceed this.
 * Scales with combat level (fallback: total level / 10), hard max 10.
 *
 * combat 1 → 1, combat 3 → 2, combat 5 → 3, … combat 19+ → 10
 */
export function huntFoundCap(
  combatLevel?: number | null,
  totalLevel?: number | null,
): number {
  const combat = Math.max(0, Math.floor(combatLevel ?? 0));
  const total = Math.max(0, Math.floor(totalLevel ?? 0));
  const level = combat > 0 ? combat : Math.max(1, Math.ceil(total / 10));
  return Math.min(10, Math.max(1, Math.ceil(level / 2)));
}

/** True when found count has hit the hard stop — Jev must not keep hunting. */
export function shouldHardStopHunt(
  found: number | null | undefined,
  combatLevel?: number | null,
  totalLevel?: number | null,
): boolean {
  return (found ?? 0) >= huntFoundCap(combatLevel, totalLevel);
}
