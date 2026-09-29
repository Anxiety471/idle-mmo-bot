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
  apiActionType?: string | null;
  readEnemies?: () => Promise<EnemyInfo[]>;
  config?: AppConfig;
  /** When true, reload once on accepted_unrendered before giving up. */
  allowReloadVerify?: boolean;
}

/**
 * Poll after a Battle click for fight-accepted signals (Run Away, tile drop, toast, API).
 */
export async function confirmBattleStarted(
  page: Page,
  options: ConfirmBattleStartedOptions,
): Promise<BattleConfirmOutcome> {
  const envMs = Number(process.env.COMBAT_FIGHT_CONFIRM_MS);
  const limitMs =
    options.timeoutMs ??
    (Number.isFinite(envMs) && envMs > 0 ? envMs : 15_000);
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + limitMs;
  const modalOpenAtClick = await isEnemyModalVisible(page);
  let sawToast = false;

  while (Date.now() < deadline) {
    const body = await page.locator('body').innerText().catch(() => '');
    if (isFightAcceptedFromPageText(body, { apiActionType: options.apiActionType })) {
      return 'started';
    }

    if (await newSonnerToastVisible(page)) {
      sawToast = true;
    }

    const modalNow = await isEnemyModalVisible(page);
    if (modalOpenAtClick && !modalNow && !sawToast) {
      // Game closes modal on on_success — fight accepted even if store is late.
      sawToast = true;
    }
    if (sawToast && !modalNow) {
      return 'accepted_unrendered';
    }

    if (options.readEnemies && options.qtyBefore !== undefined) {
      const enemies = await options.readEnemies().catch(() => [] as EnemyInfo[]);
      const afterQty = enemyTileQuantity(enemies, options.tileName);
      const listed = enemies.some(
        (e) => e.name.trim().toLowerCase() === options.tileName.trim().toLowerCase(),
      );
      if (enemyTileReducedOrGone(options.qtyBefore, afterQty, listed)) {
        return 'started';
      }
    }

    if (await isPostBattleHumanCheckExtended(page)) {
      await clickCaptchaToastAction(page);
      await solveHumanCaptchaIfPresent(page, { pollMs, maxAttempts: 5 });
      if (isFightAcceptedFromPageText(await page.locator('body').innerText().catch(() => ''), {
        apiActionType: options.apiActionType,
      })) {
        return 'started';
      }
      continue;
    }

    const modalOpen = await isEnemyModalVisible(page);
    const processing =
      (modalOpen && (await battleButtonProcessingDisabled(page))) ||
      (await huntMoreProcessingDisabled(page));
    if (modalOpen && processing) {
      await page.waitForTimeout(pollMs);
      continue;
    }

    if (
      modalOpen &&
      !(await battleButtonProcessingDisabled(page)) &&
      !isFightAcceptedFromPageText(body, { apiActionType: options.apiActionType })
    ) {
      const battleBtn = page
        .locator('[x-data*="show-battle-entity"]')
        .getByRole('button', { name: 'Battle', exact: true })
        .filter({ visible: true })
        .first();
      const enabled =
        (await battleBtn.count()) > 0 && (await battleBtn.isEnabled().catch(() => false));
      if (enabled) return 'rejected';
    }

    await page.waitForTimeout(pollMs);
  }

  const body = await page.locator('body').innerText().catch(() => '');
  if (isFightAcceptedFromPageText(body, { apiActionType: options.apiActionType })) {
    return 'started';
  }

  if (
    options.allowReloadVerify !== false &&
    options.config &&
    (await isEnemyModalVisible(page)) === false
  ) {
    await navigateTo(page, options.config, COMBAT_PATH);
    await page
      .getByText(CURRENT_ACTION_MARKER)
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
    const afterReload = await page.locator('body').innerText().catch(() => '');
    if (isFightAcceptedFromPageText(afterReload, { apiActionType: options.apiActionType })) {
      return 'started';
    }
    if (options.readEnemies && options.qtyBefore !== undefined) {
      const enemies = await options.readEnemies().catch(() => [] as EnemyInfo[]);
      const afterQty = enemyTileQuantity(enemies, options.tileName);
      const listed = enemies.some(
        (e) => e.name.trim().toLowerCase() === options.tileName.trim().toLowerCase(),
      );
      if (enemyTileReducedOrGone(options.qtyBefore, afterQty, listed)) {
        return 'started';
      }
    }
  }

  if (
    (await isEnemyModalVisible(page)) &&
    ((await battleButtonProcessingDisabled(page)) || (await huntMoreProcessingDisabled(page)))
  ) {
    return 'pending';
  }

  return 'rejected';
}
