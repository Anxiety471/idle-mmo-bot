import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { EnemyInfo } from '../types.js';
import { navigateTo } from '../browser.js';
import {
  isHumanCheckPresent,
  solveHumanCaptchaIfPresent,
} from './human-check.js';

const COMBAT_PATH = '/combat/battle';
const CURRENT_ACTION_MARKER = 'CURRENT ACTION';

export type BattleConfirmOutcome =
  | 'started'
  | 'accepted_unrendered'
  | 'pending'
  | 'rejected';

/**
 * Round 8: HTTP statuses that mean the game/Cloudflare is throttling this IP. A Battle
 * click whose Livewire request (or its redirect) gets one of these never resolves, so the
 * button sits on is_processing until the bot gives up with pending_verify.
 */
export function isThrottleResponse(status: number, url: string, gameHost = 'idle-mmo.com'): boolean {
  if (status !== 429 && status !== 503) return false;
  try {
    return new URL(url).hostname.endsWith(gameHost);
  } catch {
    return false;
  }
}

/** Backoff after a throttled Battle (BATTLE_RATE_LIMIT_BACKOFF_MS, default 5 min, max 30 min). */
export function rateLimitBackoffMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BATTLE_RATE_LIMIT_BACKOFF_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(30 * 60_000, Math.floor(raw));
  return 5 * 60_000;
}

export interface HttpWatch {
  throttled: number;
  livewire: number[];
  stop: () => void;
}

/** Count throttled responses and Livewire POST statuses while a Battle confirm runs. */
export function watchHttp(page: Page): HttpWatch {
  const watch: HttpWatch = { throttled: 0, livewire: [], stop: () => undefined };
  const onResponse = (resp: { status(): number; url(): string; request(): { method(): string } }) => {
    try {
      const status = resp.status();
      const url = resp.url();
      if (isThrottleResponse(status, url)) watch.throttled += 1;
      if (resp.request().method() === 'POST' && /\/livewire[^/]*\/update/.test(url)) {
        if (watch.livewire.length < 10) watch.livewire.push(status);
      }
    } catch {
      /* diagnostics only */
    }
  };
  const target = page as unknown as {
    on?: (event: 'response', fn: typeof onResponse) => void;
    off?: (event: 'response', fn: typeof onResponse) => void;
  };
  if (typeof target.on !== 'function') return watch;
  target.on('response', onResponse);
  watch.stop = () => target.off?.('response', onResponse);
  return watch;
}

let lastConfirmThrottled = false;

/** True when the most recent confirmBattleStarted saw the game throttling (429/503). */
export function lastBattleConfirmThrottled(): boolean {
  return lastConfirmThrottled;
}

export function battleFoodPerFightCap(): number {
  const env = Number(process.env.BATTLE_FOOD_PER_FIGHT);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return 25;
}

/** How many Cooked Cod to pack for one fight (never the whole bag). */
export function battleFoodPackQuantity(bagCooked: number, cap = battleFoodPerFightCap()): number {
  if (!Number.isFinite(bagCooked) || bagCooked <= 0) return 0;
  return Math.max(1, Math.min(Math.floor(bagCooked), cap));
}

export function parsePackedFoodQuantityFromModalText(text: string): number {
  const match = text.match(/(\d+)\s*x\b/i);
  if (!match?.[1]) return 0;
  const qty = Number.parseInt(match[1], 10);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

export function isApiBattleActionType(type: string | undefined | null): boolean {
  if (!type) return false;
  return /^battle$/i.test(type.trim());
}

export function isFightAcceptedFromPageText(
  text: string,
  opts?: { apiActionType?: string | null },
): boolean {
  if (/\bRun Away\b/.test(text)) return true;
  if (/\d+\s+Defeated\s*\/\s*\d+\s+Remaining/i.test(text)) return true;
  if (/\d+\s+Defeated\b/i.test(text) && /\d+\s+Remaining\b/i.test(text)) return true;
  if (isApiBattleActionType(opts?.apiActionType ?? undefined)) return true;
  return false;
}

export function enemyTileQuantity(
  enemies: EnemyInfo[],
  tileName: string,
): number | undefined {
  const needle = tileName.trim().toLowerCase();
  const match = enemies.find((e) => e.name.trim().toLowerCase() === needle);
  return match?.quantity;
}

export function enemyTileReducedOrGone(
  beforeQty: number | undefined,
  afterQty: number | undefined,
  tileStillListed: boolean,
): boolean {
  if (beforeQty === undefined) return false;
  if (!tileStillListed) return true;
  if (afterQty === undefined) return false;
  return afterQty < beforeQty;
}

/** Worst-case Cooked Cod after a fight (all packed food eaten, none returned yet). */
export function worstCaseCookedCodAfterFight(
  snapshotCooked: number,
  healSpent: number,
  packedFood: number,
): number {
  const base = Math.max(0, snapshotCooked - healSpent);
  return Math.max(0, base - Math.max(0, packedFood));
}

export function shouldRefreshCookGateAfterFight(
  worstCase: number,
  huntCookFloor: number,
): boolean {
  return worstCase < huntCookFloor;
}

export function isPreBattleClickFailure(result: string): boolean {
  return result === 'disabled' || result === 'missing';
}

export async function isPostBattleHumanCheckExtended(page: Page): Promise<boolean> {
  if (await isHumanCheckPresent(page)) return true;
  const gawain = page.locator('[x-data*="gawain-captcha"]').filter({ visible: true }).first();
  if ((await gawain.count()) > 0 && (await gawain.isVisible().catch(() => false))) return true;
  const toast = page.locator('.gawain-captcha-toast, .gawain-captcha-toast-action').filter({
    visible: true,
  });
  if ((await toast.count()) > 0) return true;
  const loading = page.getByText(/Loading your quick check/i);
  if ((await loading.count()) > 0 && (await loading.first().isVisible().catch(() => false))) {
    return true;
  }
  return false;
}

async function clickCaptchaToastAction(page: Page): Promise<boolean> {
  const action = page.locator('.gawain-captcha-toast-action').filter({ visible: true }).first();
  if ((await action.count()) === 0 || !(await action.isVisible().catch(() => false))) return false;
  await action.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(300);
  return true;
}

async function isEnemyModalVisible(page: Page): Promise<boolean> {
  const modal = page.locator('[x-data*="show-battle-entity"]').filter({ visible: true }).first();
  return (await modal.count()) > 0 && (await modal.isVisible().catch(() => false));
}

async function battleButtonProcessingDisabled(page: Page): Promise<boolean> {
  const btn = page
    .locator('[x-data*="show-battle-entity"]')
    .getByRole('button', { name: 'Battle', exact: true })
    .filter({ visible: true })
    .first();
  if ((await btn.count()) === 0) return false;
  const bind =
    (await btn.getAttribute('x-bind:disabled').catch(() => null)) ??
    (await btn.getAttribute(':disabled').catch(() => null));
  if (!bind) return false;
  return /is_processing/i.test(bind);
}

async function huntMoreProcessingDisabled(page: Page): Promise<boolean> {
  const btn = page.getByRole('button', { name: 'Hunt More', exact: true }).first();
  if ((await btn.count()) === 0) return false;
  const bind =
    (await btn.getAttribute('x-bind:disabled').catch(() => null)) ??
    (await btn.getAttribute(':disabled').catch(() => null));
  return Boolean(bind && /is_processing/i.test(bind));
}

async function newSonnerToastVisible(page: Page): Promise<boolean> {
  const toast = page.locator('[data-sonner-toast]').filter({ visible: true });
  return (await toast.count()) > 0;
}

export interface ConfirmBattleStartedOptions {
  tileName: string;
  qtyBefore?: number;
  pollMs?: number;
  timeoutMs?: number;
  /**
   * Ignored for confirmation: a snapshot API type was read before the click, so it can
   * only describe a fight that was already running. Kept for call-site compatibility.
   */
  apiActionType?: string | null;
  readEnemies?: () => Promise<EnemyInfo[]>;
  config?: AppConfig;
  /** When true, reload once on accepted_unrendered before giving up. */
  allowReloadVerify?: boolean;
  /**
   * Called when "Start a new action?" is visible during the poll (gather-busy Battle
   * where the dialog rendered late). Return true to keep polling, false to stop as
   * `rejected`. Without it the dialog just sits on top of an is_processing Battle.
   */
  onReplaceDialog?: () => Promise<boolean>;
}

async function replaceDialogVisible(page: Page): Promise<boolean> {
  return page
    .getByText('Start a new action?', { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * Tile-drop signal tied to THIS click: the fought tile (qtyBefore captured right before
 * the Battle click) is gone or smaller. An empty/failed read never counts.
 * With duplicate names, confirmed only when no same-name tile still has >= qtyBefore.
 */
export function tileDropConfirmed(
  enemies: EnemyInfo[],
  tileName: string,
  qtyBefore: number | undefined,
): boolean {
  if (qtyBefore === undefined || !Number.isFinite(qtyBefore) || qtyBefore <= 0) return false;
  if (enemies.length === 0) return false;
  const needle = tileName.trim().toLowerCase();
  const same = enemies.filter((e) => e.name.trim().toLowerCase() === needle);
  if (same.length === 0) return true;
  if (same.some((e) => e.quantity === undefined)) return false;
  return same.every((e) => (e.quantity as number) < qtyBefore);
}

/** Visible Run Away only (the confirm-modal copy is hidden). */
async function runAwayVisible(page: Page): Promise<boolean> {
  const btn = page.getByRole('button', { name: 'Run Away', exact: true }).filter({ visible: true });
  return (await btn.count().catch(() => 0)) > 0;
}

async function tileDropAfterClick(
  options: ConfirmBattleStartedOptions,
): Promise<boolean> {
  if (!options.readEnemies || options.qtyBefore === undefined) return false;
  let enemies: EnemyInfo[];
  try {
    enemies = await options.readEnemies();
  } catch {
    return false;
  }
  return tileDropConfirmed(enemies, options.tileName, options.qtyBefore);
}

/**
 * Poll after a Battle click. Only two signals count as `started`, both tied to this click
 * (callers skip the click when a fight was already on screen):
 *  - a visible Run Away button (not page text), or
 *  - the fought tile dropping/vanishing versus qtyBefore read just before the click.
 * The game closing the modal / a toast is only a hint: it triggers a reload verify and,
 * if neither signal shows, returns `accepted_unrendered` (never credited).
 */
export async function confirmBattleStarted(
  page: Page,
  options: ConfirmBattleStartedOptions,
): Promise<BattleConfirmOutcome> {
  lastConfirmThrottled = false;
  const http = watchHttp(page);
  try {
    const outcome = await confirmBattleStartedInner(page, options, http);
    lastConfirmThrottled =
      (outcome === 'pending' || outcome === 'accepted_unrendered') && http.throttled > 0;
    return outcome;
  } finally {
    http.stop();
  }
}

async function confirmBattleStartedInner(
  page: Page,
  options: ConfirmBattleStartedOptions,
  http: HttpWatch,
): Promise<BattleConfirmOutcome> {
  const envMs = Number(process.env.COMBAT_FIGHT_CONFIRM_MS);
  const limitMs =
    options.timeoutMs ??
    (Number.isFinite(envMs) && envMs > 0 ? envMs : 15_000);
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + limitMs;
  const modalOpenAtClick = await isEnemyModalVisible(page);
  let acceptHint = false;
  let captchaRounds = 0;

  let replaceRounds = 0;

  while (Date.now() < deadline) {
    if (await runAwayVisible(page)) return 'started';

    if (options.onReplaceDialog && replaceRounds < 2 && (await replaceDialogVisible(page))) {
      replaceRounds += 1;
      if (!(await options.onReplaceDialog())) return 'rejected';
      continue;
    }

    const modalNow = await isEnemyModalVisible(page);
    if (modalOpenAtClick && !modalNow) {
      // Game closes show-battle-entity in on_success — verify below, do not credit yet.
      acceptHint = true;
      // Give the store a moment to hydrate Run Away before reloading.
      const hydrateUntil = Math.min(deadline, Date.now() + 5_000);
      while (Date.now() < hydrateUntil) {
        await page.waitForTimeout(pollMs);
        if (await runAwayVisible(page)) return 'started';
        if (await tileDropAfterClick(options)) return 'started';
      }
      break;
    }

    if (modalNow && (await tileDropAfterClick(options))) return 'started';

    if (captchaRounds < 3 && (await isPostBattleHumanCheckExtended(page))) {
      captchaRounds += 1;
      await clickCaptchaToastAction(page);
      await solveHumanCaptchaIfPresent(page, { pollMs, maxAttempts: 5 });
      continue;
    }

    const processing =
      (modalNow && (await battleButtonProcessingDisabled(page))) ||
      (await huntMoreProcessingDisabled(page));
    if (modalNow && processing) {
      await page.waitForTimeout(pollMs);
      continue;
    }

    if (modalNow && !(await battleButtonProcessingDisabled(page))) {
      const battleBtn = page
        .locator('[x-data*="show-battle-entity"]')
        .getByRole('button', { name: 'Battle', exact: true })
        .filter({ visible: true })
        .first();
      const enabled =
        (await battleBtn.count()) > 0 && (await battleBtn.isEnabled().catch(() => false));
      if (enabled && !(await newSonnerToastVisible(page))) return 'rejected';
    }

    await page.waitForTimeout(pollMs);
  }

  if (await runAwayVisible(page)) return 'started';

  const modalOpen = await isEnemyModalVisible(page);
  if (options.allowReloadVerify !== false && options.config && !modalOpen && http.throttled === 0) {
    await navigateTo(page, options.config, COMBAT_PATH);
    await page
      .getByText(CURRENT_ACTION_MARKER)
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
    if (await runAwayVisible(page)) return 'started';
    if (await tileDropAfterClick(options)) return 'started';
  }

  if (acceptHint) return 'accepted_unrendered';

  if (
    modalOpen &&
    ((await battleButtonProcessingDisabled(page)) || (await huntMoreProcessingDisabled(page)))
  ) {
    // Round 7: the Battle request is still in flight. Before giving up (reload, no credit)
    // wait a little longer — solving a late Quick check — then reload and re-read the
    // battle state so a fight that did start is credited instead of thrown away.
    if (http.throttled > 0) {
      // Throttled: the request will not complete and a reload would hit the same 429 /
      // challenge. Stop here; the caller backs off instead of hammering the server.
      console.log(
        `[combat] Battle still processing after ${Math.round(limitMs / 1000)}s — server throttling ` +
          `(${await pendingDiagnostics(page, http)}); backing off, no reload`,
      );
      return 'pending';
    }
    const extraMs = pendingExtraWaitMs();
    const extraDeadline = Date.now() + extraMs;
    console.log(
      `[combat] Battle still processing after ${Math.round(limitMs / 1000)}s — ` +
        `waiting up to ${Math.round(extraMs / 1000)}s more (${await pendingDiagnostics(page, http)})`,
    );
    while (Date.now() < extraDeadline) {
      if (await runAwayVisible(page)) return 'started';
      if (await tileDropAfterClick(options)) return 'started';
      if (captchaRounds < 5 && (await isPostBattleHumanCheckExtended(page))) {
        captchaRounds += 1;
        console.log('[combat] Quick check surfaced during pending wait — solving');
        await clickCaptchaToastAction(page);
        await solveHumanCaptchaIfPresent(page, { pollMs, maxAttempts: 5 });
        continue;
      }
      const stillOpen = await isEnemyModalVisible(page);
      const stillProcessing =
        stillOpen &&
        ((await battleButtonProcessingDisabled(page)) || (await huntMoreProcessingDisabled(page)));
      if (!stillProcessing) break;
      await page.waitForTimeout(pollMs);
    }
    if (await runAwayVisible(page)) return 'started';
    if (http.throttled > 0) {
      console.log(`[combat] Battle pending — server throttling (${await pendingDiagnostics(page, http)}); no reload`);
      return 'pending';
    }
    if (options.config) {
      await navigateTo(page, options.config, COMBAT_PATH);
      await page
        .getByText(CURRENT_ACTION_MARKER)
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1_500);
      if (await runAwayVisible(page)) {
        console.log('[combat] pending Battle was accepted — Run Away visible after reload');
        return 'started';
      }
      if (await tileDropAfterClick(options)) {
        console.log('[combat] pending Battle was accepted — enemy tile dropped after reload');
        return 'started';
      }
    }
    return 'pending';
  }

  return 'rejected';
}

/** Extra wait after the confirm window while Battle is still is_processing (COMBAT_PENDING_EXTRA_MS). */
export function pendingExtraWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COMBAT_PENDING_EXTRA_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(120_000, Math.floor(raw));
  return 20_000;
}

/** Short, non-sensitive UI hints for a stuck Battle: toast text and overlay flags. */
async function pendingDiagnostics(page: Page, http?: HttpWatch): Promise<string> {
  const bits: string[] = [];
  if (http) {
    if (http.throttled > 0) bits.push(`http_throttled=${http.throttled}`);
    bits.push(`livewire=[${http.livewire.join(',')}]`);
  }
  try {
    const toasts = page.locator('[data-sonner-toast]').filter({ visible: true });
    const n = await toasts.count();
    for (let i = 0; i < Math.min(n, 3); i++) {
      const t = ((await toasts.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (t) bits.push(`toast="${t.slice(0, 80)}"`);
    }
    if (await isPostBattleHumanCheckExtended(page)) bits.push('quick_check=visible');
    const foodLayer = page.locator('[x-data*="food-for-battle"], [x-data*="select-battle-food-quantity"]').filter({ visible: true });
    if ((await foodLayer.count()) > 0) bits.push('food_picker=open');
  } catch {
    /* diagnostics only */
  }
  const ui = bits.filter((b) => !b.startsWith('livewire=') && !b.startsWith('http_throttled='));
  return ui.length ? bits.join(' ') : `${bits.join(' ')} no toast/captcha/overlay`.trim();
}
