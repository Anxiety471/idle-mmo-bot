/**
 * Round 10: the game is AFK — time the next tick from the running action instead of
 * polling. After each cycle the bot reads the CURRENT ACTION countdown (e.g. "02:55:37")
 * and sleeps until it ends plus a random 10–60 s buffer. The Public API `expires_at` is
 * per-item (seconds) and sometimes ~6 h skewed, so it is not used for the batch end.
 * Without a readable timer the bot falls back to FALLBACK_POLL_MS (default 5 min).
 */
import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { SkillId } from '../types.js';
import { readSkillState } from '../deterministic/gather.js';

const MARKER = 'CURRENT ACTION';

function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = Number(env[name]);
  const v = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  return Math.max(min, Math.min(max, v));
}

/** FALLBACK_POLL_MS: default 5 min, never below 1 min, max 1 h. */
export function fallbackPollMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'FALLBACK_POLL_MS', 300_000, 60_000, 3_600_000);
}

/** ACTION_SLEEP_MAX_MS: longest timer-based sleep (default 3 h). */
export function actionSleepMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'ACTION_SLEEP_MAX_MS', 3 * 3_600_000, 60_000, 12 * 3_600_000);
}

/** Timed sleep is on unless TIMED_SLEEP=false (then the old POLL_MS loop is used). */
export function timedSleepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.TIMED_SLEEP?.trim() ?? '');
}

/**
 * Remaining time of the CURRENT ACTION panel in ms, from its first H:MM:SS / MM:SS token.
 * "Next item in 0:05" (per-item tick) is ignored.
 */
export function parseCurrentActionRemainingMs(pageText: string): number | undefined {
  const start = pageText.indexOf(MARKER);
  if (start < 0) return undefined;
  const section = pageText.slice(start + MARKER.length, start + MARKER.length + 600);
  const cleaned = section.replace(/next item in\s*[\d:]+/gi, ' ');
  const m = cleaned.match(/(?:^|\s)(\d{1,3}):(\d{2}):(\d{2})(?:\s|$)/) ?? cleaned.match(/(?:^|\s)()(\d{1,2}):(\d{2})(?:\s|$)/);
  if (!m) return undefined;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (![h, min, s].every(Number.isFinite) || min > 59 || s > 59) return undefined;
  const ms = ((h * 60 + min) * 60 + s) * 1000;
  return ms > 0 ? ms : undefined;
}

/** Random buffer between 10 and 60 s (ACTION_BUFFER_MIN_MS / ACTION_BUFFER_MAX_MS). */
export function randomBufferMs(rng: () => number = Math.random, env: NodeJS.ProcessEnv = process.env): number {
  const lo = envMs(env, 'ACTION_BUFFER_MIN_MS', 10_000, 0, 600_000);
  const hi = Math.max(lo, envMs(env, 'ACTION_BUFFER_MAX_MS', 60_000, 0, 600_000));
  return Math.round(lo + (hi - lo) * rng());
}

export interface SleepPlan {
  sleepMs: number;
  source: 'timer' | 'fallback' | 'backoff';
  timerMs?: number;
}

/** Decide how long to sleep: explicit backoff wins, else timer + buffer, else fallback. */
export function planSleep(
  input: { backoffMs?: number; timerMs?: number },
  rng: () => number = Math.random,
  env: NodeJS.ProcessEnv = process.env,
): SleepPlan {
  const fallback = fallbackPollMs(env);
  if (input.timerMs !== undefined && input.timerMs > 0) {
    const sleepMs = Math.min(actionSleepMaxMs(env), input.timerMs + randomBufferMs(rng, env));
    if (input.backoffMs !== undefined && input.backoffMs > sleepMs) {
      return { sleepMs: input.backoffMs, source: 'backoff', timerMs: input.timerMs };
    }
    return { sleepMs, source: 'timer', timerMs: input.timerMs };
  }
  if (input.backoffMs !== undefined && input.backoffMs > 0) {
    return { sleepMs: input.backoffMs, source: 'backoff' };
  }
  return { sleepMs: fallback, source: 'fallback' };
}

const ACTION_SKILL: Record<string, SkillId> = {
  mine_coal: 'mining',
  fish_cod: 'fishing',
  cook_cod: 'cooking',
  gather_oak: 'woodcutting',
  gather_yew: 'woodcutting',
};

/**
 * Read the running action's remaining time: the current page first, then (for gather /
 * fish / cook, or continue_current with a known skill) that skill's page. Never throws.
 */
export async function readActionTimerMs(
  page: Page,
  config: AppConfig,
  action: string,
  apiSkill?: SkillId,
): Promise<number | undefined> {
  try {
    const here = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    const fromHere = parseCurrentActionRemainingMs(here);
    if (fromHere !== undefined) return fromHere;
    const skill = ACTION_SKILL[action] ?? (action === 'continue_current' ? apiSkill : undefined) ?? apiSkill;
    if (!skill) return undefined;
    const state = await readSkillState(page, config, skill);
    return parseCurrentActionRemainingMs(state.pageText);
  } catch {
    return undefined;
  }
}
