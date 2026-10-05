/**
 * Round 9: cut request volume and coordinate the three bots that share one IP.
 *
 * - blockHeavyResources: abort fonts, media and third-party analytics (never game
 *   documents, scripts, XHR/fetch or images; enemy tiles and the Quick check need those).
 * - Shared throttle flag (THROTTLE_FILE): any bot that sees 429s writes "until" so every
 *   bot backs off, not just the one that clicked Battle.
 * - Shared Battle gap (BATTLE_LOCK_FILE): bots never click Battle closer than
 *   BATTLE_MIN_GAP_MS (default 20 s) apart.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext } from 'playwright';

const SHARED_DIR = process.env.IDLE_MMO_SHARED_DIR?.trim() || '/workspace/.idle-mmo-shared';
export const THROTTLE_FILE = `${SHARED_DIR}/throttle-until.json`;
export const BATTLE_LOCK_FILE = `${SHARED_DIR}/battle-last.json`;

/** Off under node:test (unit tests must not touch the live bots' shared files) or SHARED_LIMITER=false. */
export function sharedLimiterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_TEST_CONTEXT) return false;
  return !/^(0|false|no)$/i.test(env.SHARED_LIMITER?.trim() ?? '');
}

const ANALYTICS_HOST =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|clarity\.ms|hotjar|facebook\.net|segment\.io|mixpanel|plausible|adservice)/i;

/** Pure: should this request be aborted to save bandwidth/requests? */
export function shouldBlockRequest(resourceType: string, url: string): boolean {
  if (resourceType === 'font' || resourceType === 'media') return true;
  try {
    return ANALYTICS_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function blockHeavyResources(context: BrowserContext, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (/^(0|false|no)$/i.test(env.BLOCK_HEAVY_RESOURCES?.trim() ?? '')) return;
  await context.route('**/*', (route) => {
    const req = route.request();
    if (shouldBlockRequest(req.resourceType(), req.url())) return route.abort();
    return route.continue();
  });
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch {
    /* best effort */
  }
}

/** Pure: ms left in a shared throttle window (0 when none / expired). */
export function throttleRemainingMs(record: Record<string, unknown> | undefined, now: number): number {
  const until = Number(record?.until);
  return Number.isFinite(until) && until > now ? until - now : 0;
}

/** Record a shared throttle so every bot on this box backs off until now + ms. */
export function noteSharedThrottle(ms: number, who: string, now = Date.now(), path = THROTTLE_FILE): void {
  if (path === THROTTLE_FILE && !sharedLimiterEnabled()) return;
  const current = throttleRemainingMs(readJson(path), now);
  if (current >= ms) return;
  writeJson(path, { until: now + ms, by: who, at: new Date(now).toISOString() });
}

export function sharedThrottleRemainingMs(now = Date.now(), path = THROTTLE_FILE): number {
  if (path === THROTTLE_FILE && !sharedLimiterEnabled()) return 0;
  return throttleRemainingMs(readJson(path), now);
}

export function battleMinGapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BATTLE_MIN_GAP_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(10 * 60_000, Math.floor(raw));
  return 20_000;
}

/** Pure: wait needed before the next Battle click given the last shared click time. */
export function battleGapWaitMs(record: Record<string, unknown> | undefined, now: number, gapMs: number): number {
  const last = Number(record?.at);
  if (!Number.isFinite(last) || last > now) return 0;
  return Math.max(0, last + gapMs - now);
}

/**
 * Wait for the shared Battle slot (max maxWaitMs), then claim it. Returns ms waited.
 * Not a strict mutex: a tiny race only means two clicks a few ms apart, never a deadlock.
 */
export async function claimBattleSlot(
  who: string,
  options: { gapMs?: number; maxWaitMs?: number; path?: string } = {},
): Promise<number> {
  const gapMs = options.gapMs ?? battleMinGapMs();
  const path = options.path ?? BATTLE_LOCK_FILE;
  if (!options.path && !sharedLimiterEnabled()) return 0;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const start = Date.now();
  for (;;) {
    const wait = battleGapWaitMs(readJson(path), Date.now(), gapMs);
    if (wait <= 0 || Date.now() - start >= maxWaitMs) break;
    await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)));
  }
  writeJson(path, { at: Date.now(), by: who });
  return Date.now() - start;
}
