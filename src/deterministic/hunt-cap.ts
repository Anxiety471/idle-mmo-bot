/**
 * Hard stop for hunting: battle once Total Enemies Found reaches this count.
 * Default is 100 (same batch size as coal / fish / cook). Override with HUNT_FOUND_CAP.
 * Combat level does not change the cap — Jev cannot hunt past it or battle before it.
 */
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

/** True when Total Enemies Found has hit the battle threshold — stop and battle. */
export function shouldHardStopHunt(
  found: number | null | undefined,
  combatLevel?: number | null,
  totalLevel?: number | null,
): boolean {
  return (found ?? 0) >= huntFoundCap(combatLevel, totalLevel);
}
