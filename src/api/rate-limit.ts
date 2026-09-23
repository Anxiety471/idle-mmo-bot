/** Standard IdleMMO Public API limit: 20 requests per minute per account. */
export const PUBLIC_API_MAX_PER_MINUTE = 20;

const WINDOW_MS = 60_000;

/**
 * Minimum gap between full refreshes so `requestCount` calls stay under the
 * account cap with a little headroom for a retry.
 */
export function minSafeIntervalMs(
  requestCount: number,
  maxPerMinute = PUBLIC_API_MAX_PER_MINUTE,
): number {
  const calls = Math.max(1, requestCount);
  const budget = Math.max(1, maxPerMinute - 2);
  return Math.ceil((calls * WINDOW_MS) / budget);
}

export class SlidingWindowRateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(): boolean {
    const now = this.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < WINDOW_MS);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }

  reset(): void {
    this.stamps = [];
  }
}
