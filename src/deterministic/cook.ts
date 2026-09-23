import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { GatherRestartResult } from '../types.js';
import { navigateTo } from '../browser.js';
import { getSkillConfig } from './skills.js';
import { solveHumanCaptchaIfPresent } from './human-check.js';

/**
 * While something else is running, only start a cook when the caller allows
 * interrupting it. An in-progress cook is left alone.
 */
export function cookInterruptDecision(
  pageText: string,
  allowInterrupt: boolean,
): 'proceed' | 'already_busy' {
  const idx = pageText.indexOf('CURRENT ACTION');
  if (idx < 0) return 'proceed';
  const slice = pageText.slice(idx, idx + 500);
  if (/cook/i.test(slice)) return 'already_busy';
  if (!allowInterrupt) return 'already_busy';
  return 'proceed';
}

const CURRENT_ACTION_MARKER = 'CURRENT ACTION';
/** Max time to wait for the cooking page (recipe list or an active cook). */
const COOK_UI_SETTLE_MS = 10_000;
/** Detail panel after the recipe card is selected (Start / quantity). */
const COOK_PANEL_READY_MS = 4_000;
/** Transient CDN / overlay misses — same budget as mining's Start retry. */
const COOK_START_ATTEMPTS = 3;
/**
 * One Cooked Cod is ~8s. A batch keeps CURRENT ACTION up across the next
 * autopilot tick so a healthy cook is left alone instead of re-hitting Start.
 * Capped (no Max) so a full Cod stack is not dumped into one action.
 */
const COOK_QUANTITY_BATCH = 8;

/**
 * Recipe cards are named "Cooked Cod Lv. 1 2 EXP …", not the bare label.
 * Prefix match avoids unrelated controls that merely mention Cooked Cod.
 */
export const COOKED_COD_RECIPE_NAME = /^Cooked Cod\b/i;

export function matchesCookedCodRecipeName(accessibleName: string): boolean {
  return COOKED_COD_RECIPE_NAME.test(accessibleName.trim());
}

function currentActionSection(pageText: string): string {
  const idx = pageText.indexOf(CURRENT_ACTION_MARKER);
  if (idx < 0) return '';
  return pageText.slice(idx, idx + 900);
}

/**
 * True when CURRENT ACTION is a live Cooked Cod cook.
 * The cooking verb or the producing timer/counter must sit next to that
 * recipe name. A later recipe card, or a hunt "+N" elsewhere in the panel,
 * does not count — otherwise a Start click that never took looks like success.
 */
export function isActiveCookedCodAction(pageText: string): boolean {
  const section = currentActionSection(pageText);
  if (!section) return false;
  const match = /\bcooked cod\b/i.exec(section);
  if (!match || match.index === undefined) return false;

  const before = section.slice(Math.max(0, match.index - 160), match.index);
  if (/\bcooked (?:salmon|tuna)\b/i.test(before)) return false;

  const after = section.slice(match.index, match.index + match[0].length + 160);
  return (
    /\bcook(?:ing)?\b/i.test(before) ||
    /\bcook(?:ing)?\b/i.test(after) ||
    /next item in\s*\d/i.test(after) ||
    /\+\d+(?:\.\d+)?[kK]?\b/.test(after)
  );
}

/**
 * Wait until the cooking page shows an active action, Start, or the recipe card.
 * CURRENT ACTION and the recipe list both load after domcontentloaded.
 */
async function waitForCookingUiSettled(
  page: Page,
  timeoutMs = COOK_UI_SETTLE_MS,
): Promise<void> {
  const busyIndicator = page.getByText(CURRENT_ACTION_MARKER);
  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  const recipe = page.getByRole('button', { name: COOKED_COD_RECIPE_NAME });
  await busyIndicator
    .or(startButton)
    .or(recipe)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {
      // Best-effort: read state anyway rather than hanging the cycle.
    });
}

/** Wait for the recipe detail panel after selecting Cooked Cod. */
async function waitForCookPanelReady(page: Page, timeoutMs = COOK_PANEL_READY_MS): Promise<void> {
  const qty = page.locator('input[name="quantity"]');
  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  const canPerform = page.getByText(/you can perform this action\s+\d+\s+times/i);
  await qty
    .or(startButton)
    .or(canPerform)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => undefined);
  await page.waitForTimeout(150);
}

/** Dismiss leftover modal overlays that intercept recipe / Start clicks. */
async function dismissBlockingOverlays(page: Page): Promise<void> {
  const overlay = page.locator('div.fixed.inset-0 div.absolute.inset-0.bg-immo');
  const dialog = page.getByText('Start a new action?');
  const blocking =
    (await overlay.count()) > 0 || (await dialog.isVisible().catch(() => false));
  if (!blocking) {
    const close = page.getByRole('button', { name: 'Close', exact: true });
    if ((await close.count()) > 0 && (await close.first().isVisible().catch(() => false))) {
      await close.first().click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
    return;
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(150);
  }
  for (const name of ['Close', 'Cancel'] as const) {
    const btn = page.getByRole('button', { name, exact: true });
    if ((await btn.count()) > 0 && (await btn.first().isVisible().catch(() => false))) {
      await btn.first().click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
  }
}

async function setCookQuantity(page: Page, value: string): Promise<void> {
  const qty = page.locator('input[name="quantity"]');
  if ((await qty.count()) === 0) return;
  await qty.first().fill(value).catch(() => undefined);
  await qty.first().dispatchEvent('input').catch(() => undefined);
  await qty.first().dispatchEvent('change').catch(() => undefined);
  await page.waitForTimeout(200);
}

/**
 * How many Cooked Cod to queue. Default batch is 8; never above what the
 * panel says we can perform, and never Max (that would cook the whole stack).
 */
export function cookBatchQuantity(pageText: string, batch = COOK_QUANTITY_BATCH): number {
  const match = pageText.match(/you can perform this action\s+(\d+)\s+times/i);
  if (!match) return batch;
  const available = Number(match[1]);
  if (!Number.isFinite(available) || available <= 0) return 1;
  return Math.max(1, Math.min(batch, available));
}

async function setCookQuantityBatch(page: Page, batch = COOK_QUANTITY_BATCH): Promise<void> {
  const qty = page.locator('input[name="quantity"]');
  if ((await qty.count()) === 0) return;
  const pageText = await page.locator('body').innerText().catch(() => '');
  await setCookQuantity(page, String(cookBatchQuantity(pageText, batch)));
}

type StartReadiness = 'ready' | 'missing' | 'disabled';

/**
 * Visible Start, ignoring the tiny aria-hidden submit that can steal `.first()`.
 * Disabled-but-visible is a materials problem; no visible Start is a UI miss.
 */
async function readStartReadiness(page: Page): Promise<StartReadiness> {
  const starts = page.getByRole('button', { name: 'Start', exact: true });
  await starts
    .first()
    .waitFor({ state: 'visible', timeout: COOK_PANEL_READY_MS })
    .catch(() => undefined);

  const count = await starts.count();
  if (count === 0) return 'missing';

  let anyVisible = false;
  let anyEnabled = false;
  for (let i = 0; i < count; i++) {
    const btn = starts.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const box = await btn.boundingBox().catch(() => null);
    if (!box || box.width < 8 || box.height < 8) continue;
    anyVisible = true;
    if (!(await btn.isDisabled().catch(() => true))) anyEnabled = true;
  }
  if (!anyVisible) return 'missing';
  if (!anyEnabled) return 'disabled';
  return 'ready';
}

/** Prefer the largest visible enabled Start. */
async function clickEnabledStart(page: Page): Promise<boolean> {
  const starts = page.getByRole('button', { name: 'Start', exact: true });
  const count = await starts.count();
  if (count === 0) return false;
  let bestIdx = -1;
  let bestArea = -1;
  for (let i = 0; i < count; i++) {
    const box = await starts.nth(i).boundingBox().catch(() => null);
    const area = box ? box.width * box.height : 0;
    const disabled = await starts.nth(i).isDisabled().catch(() => true);
    if (disabled || area < 8) continue;
    if (area > bestArea) {
      bestArea = area;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return false;
  await starts.nth(bestIdx).scrollIntoViewIfNeeded().catch(() => undefined);
  await starts.nth(bestIdx).click({ force: true, timeout: 5000 });
  return true;
}

async function clickCookedCodRecipe(page: Page): Promise<boolean> {
  const recipe = page.getByRole('button', { name: COOKED_COD_RECIPE_NAME });
  await recipe
    .first()
    .waitFor({ state: 'visible', timeout: COOK_UI_SETTLE_MS })
    .catch(() => undefined);

  const count = await recipe.count();
  for (let i = 0; i < count; i++) {
    const btn = recipe.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await btn.boundingBox().catch(() => null);
    if (!box || box.width < 40 || box.height < 20) continue;
    await btn.click({ force: true, timeout: 5000 });
    await page.waitForTimeout(350);
    return true;
  }
  return false;
}

async function confirmReplaceDialog(
  page: Page,
  allowInterrupt: boolean,
): Promise<'ok' | 'failed' | 'kept'> {
  const dialog = page.getByText(/Start a new action\?/i);
  if (!(await dialog.isVisible({ timeout: 2000 }).catch(() => false))) {
    return 'ok';
  }
  if (!allowInterrupt) {
    const closeButton = page.getByRole('button', { name: 'Close', exact: true });
    if ((await closeButton.count()) > 0) {
      await closeButton.first().click({ force: true }).catch(() => undefined);
    }
    return 'kept';
  }
  const startAnyway = page.getByRole('button', { name: /start anyway/i });
  if ((await startAnyway.count()) > 0) {
    await startAnyway.first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(400);
    return 'ok';
  }
  return 'failed';
}

async function readBody(page: Page): Promise<string> {
  return page.locator('body').innerText().catch(() => '');
}

/**
 * Cook Cod into Cooked Cod for pre-battle food (effective HP heal).
 * Recipe on /skills/view/cooking: button label like
 * "Cooked Cod Lv. 1 2 EXP 8 s 1 x Cod 1 x Coal Ore".
 *
 * `restarted` is returned only after CURRENT ACTION shows a Cooked Cod cook.
 * A Start click that never takes (slow CDN, overlay, captcha) is `failed`.
 */
export async function tryCookCod(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<GatherRestartResult> {
  const skill = getSkillConfig('cooking');
  let last: GatherRestartResult = 'failed';

  for (let attempt = 0; attempt < COOK_START_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      console.log(`[cook] retrying Cooked Cod start (${attempt + 1}/${COOK_START_ATTEMPTS})`);
    }
    await navigateTo(page, config, skill.path);
    await waitForCookingUiSettled(page);

    const pageText = await readBody(page);
    if (cookInterruptDecision(pageText, allowInterrupt) === 'already_busy') {
      return 'already_busy';
    }

    last = await attemptCookCodStart(page, allowInterrupt);
    if (last !== 'failed') return last;
  }

  return last;
}

async function attemptCookCodStart(
  page: Page,
  allowInterrupt: boolean,
): Promise<GatherRestartResult> {
  await dismissBlockingOverlays(page);
  await solveHumanCaptchaIfPresent(page);

  if (!(await clickCookedCodRecipe(page))) {
    console.log('[cook] Cooked Cod recipe card not found');
    return 'failed';
  }

  await waitForCookPanelReady(page);
  await setCookQuantityBatch(page);

  let readiness = await readStartReadiness(page);
  if (readiness === 'disabled') {
    await setCookQuantity(page, '1');
    readiness = await readStartReadiness(page);
  }
  if (readiness === 'disabled') {
    await page.waitForTimeout(400);
    readiness = await readStartReadiness(page);
  }
  if (readiness === 'missing') {
    console.log('[cook] Start button missing after selecting Cooked Cod');
    return 'failed';
  }
  if (readiness === 'disabled') {
    console.log('[cook] Start disabled — need Cod + Coal Ore');
    return 'missing_requirement';
  }

  if (!(await clickEnabledStart(page))) {
    console.log('[cook] Start button missing after selecting Cooked Cod');
    return 'failed';
  }

  await page.waitForTimeout(500);
  await solveHumanCaptchaIfPresent(page);

  const replace = await confirmReplaceDialog(page, allowInterrupt);
  if (replace === 'kept') return 'kept_current_action';
  if (replace === 'failed') return 'failed';

  await page
    .getByText(CURRENT_ACTION_MARKER)
    .first()
    .waitFor({ state: 'visible', timeout: COOK_UI_SETTLE_MS })
    .catch(() => undefined);

  let finalText = await readBody(page);
  if (
    !isActiveCookedCodAction(finalText) &&
    cookInterruptDecision(finalText, allowInterrupt) !== 'already_busy'
  ) {
    // Captcha or a slow panel can swallow the first Start. One more click, then re-check.
    if (await clickEnabledStart(page)) {
      await page.waitForTimeout(400);
      const again = await confirmReplaceDialog(page, allowInterrupt);
      if (again === 'kept') return 'kept_current_action';
      if (again === 'failed') return 'failed';
      await page
        .getByText(CURRENT_ACTION_MARKER)
        .first()
        .waitFor({ state: 'visible', timeout: COOK_UI_SETTLE_MS })
        .catch(() => undefined);
      finalText = await readBody(page);
    }
  }

  if (isActiveCookedCodAction(finalText)) return 'restarted';

  console.log('[cook] Start clicked but Cooked Cod is not the current action');
  return 'failed';
}
