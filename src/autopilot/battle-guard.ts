import type { GameSnapshot } from '../types.js';

/**
 * Bounded "a battle is running" guard for --interrupt actions (cook/gather Start anyway).
 *
 * Reads the Public API current action (`type === 'BATTLE'`) and the page battle flag.
 * A stale API value must not freeze the playbook forever, so the guard gives up when
 * the API `expires_at` is well in the past, or when the same battle signal has been
 * seen continuously for longer than BATTLE_GUARD_MAX_MS (default 15 min).
 */
export type BattleGuardState = 'battle' | 'stale' | 'none';

const EXPIRED_GRACE_MS = 60_000;
const DEFAULT_MAX_MS = 15 * 60 * 1000;

let battleFirstSeenMs: number | null = null;

export function battleGuardMaxMs(): number {
  const env = Number(process.env.BATTLE_GUARD_MAX_MS);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : DEFAULT_MAX_MS;
}

export function snapshotSaysBattle(
  snapshot: Pick<GameSnapshot, 'currentAction' | 'flags'>,
): boolean {
  const type = (snapshot.currentAction?.type ?? '').trim();
  return Boolean(snapshot.flags?.inBattle) || /^battle$/i.test(type);
}

export function battleGuard(
  snapshot: Pick<GameSnapshot, 'currentAction' | 'flags'>,
  now = Date.now(),
): BattleGuardState {
  if (!snapshotSaysBattle(snapshot)) {
    battleFirstSeenMs = null;
    return 'none';
  }
  if (battleFirstSeenMs === null) battleFirstSeenMs = now;
  const pageBattle = Boolean(snapshot.flags?.inBattle);
  const expiresAt = snapshot.currentAction?.expiresAt;
  const expiresMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!pageBattle && Number.isFinite(expiresMs) && now > expiresMs + EXPIRED_GRACE_MS) {
    return 'stale';
  }
  if (now - battleFirstSeenMs > battleGuardMaxMs()) {
    return 'stale';
  }
  return 'battle';
}

/** Test helper. */
export function resetBattleGuard(): void {
  battleFirstSeenMs = null;
}
