/** Minimum sleep between hunt/combat polls — avoids sub-second Cloudflare hammering. */
export const MIN_POLL_MS = 2000;

/** Default when config pollMs is missing or invalid. */
export const DEFAULT_POLL_MS = 5000;

/** Max captcha verify attempts per combat round before long backoff. */
export const MAX_VERIFY_ATTEMPTS_PER_CYCLE = 1;

export interface VerifyBudget {
  attempts: number;
}

/** Clamp poll interval to at least MIN_POLL_MS (or config default when unset). */
export function effectivePollMs(pollMs?: number): number {
  const base = pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isFinite(base) || base <= 0) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, base);
}

/** Long backoff after verify is blocked or hunt start fails under captcha pressure. */
export function verifyBackoffMs(pollMs?: number): number {
  const effective = effectivePollMs(pollMs);
  return Math.max(effective * 6, 30_000);
}

export function createVerifyBudget(): VerifyBudget {
  return { attempts: 0 };
}

export function canAttemptVerify(budget: VerifyBudget): boolean {
  return budget.attempts < MAX_VERIFY_ATTEMPTS_PER_CYCLE;
}

export function recordVerifyAttempt(budget: VerifyBudget): void {
  budget.attempts += 1;
}
