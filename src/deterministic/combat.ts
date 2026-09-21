import type { Locator, Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { BattleState, CombatStepResult, EnemyInfo, HuntState, Stance } from '../types.js';
import { navigateTo } from '../browser.js';

/**
 * Deterministic combat click-path helpers.
 *
 * Selectors follow live-tested flows on /combat/battle.
 * UI may change — update selectors when automation breaks.
 * Never invent battle outcomes; only drive clicks and read visible state.
 *
 * Post-hunt sessions may show Hunt More / ENEMIES NEARBY without Start Hunt.
 */

const COMBAT_PATH = '/combat/battle';
/** Max wait for async combat controls after domcontentloaded (~3–4s observed). */
const COMBAT_UI_SETTLE_MS = 10_000;

/** Legacy playbook selector; UI may use other Tailwind height classes now. */
const ENEMY_CARD_HEIGHT_CLASSES = ['h-24', 'h-20', 'h-28', 'h-32'];

const ACTION_BUTTON_PATTERN =
  /^(Start Hunt|Stop|Battle|Run Away|Hunt More|Close|Start anyway|Create|Invites|Talk|Overview|Turn In)$/i;

/** Nav/chrome labels that are not enemy cards. */
const NAV_CHROME_PATTERN =
  /^(Windy|Search|Map|Party|Skills|Combat|Inventory|Quests|Merchants|Profile|Character|Settings|Menu|Playing|Equipment|Bank|Market|Woodcutting|Mining|Fishing|Alchemy|Smelting|Cooking|Forge|Construction|Meditation|show-map)$/i;

const PURE_NUMERIC_PATTERN = /^\d+$/;
const PLAYER_PROFILE_PATTERN = /\bTotal\s*Lv\.?\s*\d+/i;
const ENEMIES_NEARBY_LABEL_PATTERN = /^ENEMIES\s+NEARBY/i;

async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

async function isButtonVisible(page: Page, name: string): Promise<boolean> {
  const btn = page.getByRole('button', { name, exact: true });
  if (await btn.count() === 0) return false;
  return btn.first().isVisible();
}

/** Wait for any primary combat control after navigation. */
async function waitForCombatUiSettled(page: Page, timeoutMs = COMBAT_UI_SETTLE_MS): Promise<void> {
  const controls = page
    .getByRole('button', { name: 'Start Hunt', exact: true })
    .or(page.getByRole('button', { name: 'Hunt More', exact: true }))
    .or(page.getByRole('button', { name: 'Stop', exact: true }))
    .or(page.getByRole('button', { name: 'Battle', exact: true }));

  await controls
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {
      // Best-effort: page may already show enemy cards without these buttons visible yet.
    });
}

/** Handle "Start a new action?" after Start Hunt or Hunt More. */
async function handleReplaceDialog(
  page: Page,
  allowInterrupt: boolean,
): Promise<'continued' | 'no_action' | 'failed'> {
  const dialog = page.getByText('Start a new action?');
  if (!(await dialog.isVisible({ timeout: 2000 }).catch(() => false))) {
    return 'continued';
  }

  if (allowInterrupt) {
    const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
    if (await startAnyway.count() > 0) {
      await startAnyway.click();
      return 'continued';
    }
    return 'failed';
  }

  const closeButton = page.getByRole('button', { name: 'Close', exact: true });
  if (await closeButton.count() > 0) {
    await closeButton.click();
    return 'no_action';
  }

  return 'failed';
}

function isExcludedEnemyButton(text: string): boolean {
  const trimmed = text.trim();
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return true;
  if (PURE_NUMERIC_PATTERN.test(firstLine)) return true;
  if (ACTION_BUTTON_PATTERN.test(firstLine)) return true;
  if (NAV_CHROME_PATTERN.test(firstLine)) return true;
  if (ENEMIES_NEARBY_LABEL_PATTERN.test(firstLine)) return true;
  if (PLAYER_PROFILE_PATTERN.test(trimmed)) return true;
  if (/^[\d,.\s]+$/.test(firstLine)) return true;
  return false;
}

/** Extract creature name from a card; null when chrome/profile/count badge. */
function extractEnemyName(text: string): string | null {
  if (isExcludedEnemyButton(text)) return null;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (PURE_NUMERIC_PATTERN.test(line)) continue;
    if (/^Lv\.?\s*\d+/i.test(line)) continue;
    if (ENEMIES_NEARBY_LABEL_PATTERN.test(line)) continue;
    if (ACTION_BUTTON_PATTERN.test(line)) continue;
    if (NAV_CHROME_PATTERN.test(line)) continue;
    if (PLAYER_PROFILE_PATTERN.test(line)) continue;
    return line;
  }

  return null;
}

/** Dedicated locator for the ENEMIES NEARBY sidebar widget (not main content). */
async function getEnemiesNearbyWidget(page: Page): Promise<Locator | null> {
  const heading = page.getByText(ENEMIES_NEARBY_LABEL_PATTERN).first();
  if (await heading.count() === 0 || !(await heading.isVisible().catch(() => false))) {
    return null;
  }

  const containers = page.locator('section, div, article').filter({
    has: page.getByText(ENEMIES_NEARBY_LABEL_PATTERN),
  });

  const count = await containers.count();
  let best: Locator | null = null;
  let bestArea = Infinity;

  for (let i = 0; i < count; i++) {
    const container = containers.nth(i);
    if (!(await container.isVisible().catch(() => false))) continue;

    const tagName = await container.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    if (tagName === 'main' || tagName === 'body') continue;

    const buttons = container.getByRole('button');
    const btnCount = await buttons.count();
    let hasNumericBadge = false;
    for (let j = 0; j < btnCount; j++) {
      const btn = buttons.nth(j);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const text = (await btn.innerText()).trim();
      if (PURE_NUMERIC_PATTERN.test(text)) {
        hasNumericBadge = true;
        break;
      }
    }
    if (!hasNumericBadge) continue;

    const box = await container.boundingBox();
    if (!box) continue;
    const area = box.width * box.height;
    if (area < bestArea) {
      bestArea = area;
      best = container;
    }
  }

  if (best) return best;

  const fallback = heading.locator('xpath=./parent::div | ./parent::section');
  if (await fallback.count() > 0) {
    const tag = await fallback.first().evaluate((el) => el.tagName.toLowerCase()).catch(() => 'main');
    if (tag !== 'main' && tag !== 'body') return fallback.first();
  }

  return null;
}

/** Prefer the ENEMIES NEARBY panel; fall back to main content. */
async function getEnemySearchRoot(page: Page): Promise<Locator> {
  const label = page.getByText(/ENEMIES\s+NEARBY/i).first();
  if (await label.count() > 0 && await label.isVisible().catch(() => false)) {
    const containers = page.locator('section, div, article').filter({
      has: page.getByText(/ENEMIES\s+NEARBY/i),
    });
    const count = await containers.count();
    for (let i = count - 1; i >= 0; i--) {
      const container = containers.nth(i);
      const cardCount = await container.locator('button.h-24, button.h-20, button.h-28').count();
      if (cardCount > 0) return container;
    }

    const widget = await getEnemiesNearbyWidget(page);
    if (widget) return widget;

    if (count > 0) return containers.last();
  }

  const main = page.locator('main');
  if (await main.count() > 0) return main.first();
  return page.locator('body');
}

async function filterVisibleEnemyButtons(locator: Locator): Promise<Locator[]> {
  const count = await locator.count();
  const visible: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const btn = locator.nth(i);
    if (!(await btn.isVisible())) continue;
    const text = (await btn.innerText()).trim();
    if (isExcludedEnemyButton(text)) continue;
    if (!extractEnemyName(text)) continue;
    visible.push(btn);
  }
  return visible;
}

async function collectCardsInScope(scope: Locator): Promise<Locator[]> {
  for (const cls of ENEMY_CARD_HEIGHT_CLASSES) {
    const cards = scope.locator(`button.${cls}`);
    const visible = await filterVisibleEnemyButtons(cards);
    if (visible.length > 0) return visible;
  }

  const withLevel = scope.getByRole('button').filter({ hasText: /\bLv\.?\s*\d+/i });
  const levelVisible = await filterVisibleEnemyButtons(withLevel);
  if (levelVisible.length > 0) return levelVisible;

  const buttons = scope.getByRole('button');
  const count = await buttons.count();
  const heuristic: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible())) continue;
    const text = (await btn.innerText()).trim();
    if (isExcludedEnemyButton(text)) continue;
    const name = extractEnemyName(text);
    if (!name) continue;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2 && !/\bLv\.?\s*\d+/i.test(text)) continue;
    heuristic.push(btn);
  }
  return heuristic;
}

/** Collect visible enemy card buttons; scoped to ENEMIES NEARBY when present. */
async function collectEnemyCardButtons(page: Page): Promise<Locator[]> {
  const root = await getEnemySearchRoot(page);
  const scoped = await collectCardsInScope(root);
  if (scoped.length > 0) return scoped;

  const main = page.locator('main');
  if (await main.count() > 0) {
    const fromMain = await collectCardsInScope(main.first());
    if (fromMain.length > 0) return fromMain;
  }

  return [];
}

async function enemyInfosFromButtons(buttons: Locator[]): Promise<EnemyInfo[]> {
  const enemies: EnemyInfo[] = [];
  for (let i = 0; i < buttons.length; i++) {
    const text = (await buttons[i].innerText()).trim();
    const name = extractEnemyName(text);
    if (!name) continue;
    enemies.push({ name, index: enemies.length });
  }
  return enemies;
}

async function isEnemyDetailPanelOpen(page: Page): Promise<boolean> {
  const hasStance = await page
    .getByText(/^STANCE$/i)
    .first()
    .isVisible()
    .catch(() => false);
  const hasBattle = await page
    .getByRole('button', { name: 'Battle', exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  return hasStance && hasBattle;
}

/** Numeric count button in ENEMIES NEARBY (e.g. "40") — opens enemy detail panel. */
async function findEnemiesNearbyCountButton(page: Page): Promise<Locator | null> {
  const widget = await getEnemiesNearbyWidget(page);
  if (!widget) return null;

  const buttons = widget.getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible())) continue;
    const text = (await btn.innerText()).trim();
    if (PURE_NUMERIC_PATTERN.test(text)) return btn;
  }
  return null;
}

async function dismissBlockingOverlays(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);

  const overlays = page.locator('div.absolute.inset-0.bg-immo');
  const overlayCount = await overlays.count();
  for (let i = 0; i < overlayCount; i++) {
    await overlays.nth(i).waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined);
  }

  const closeBtn = page.getByRole('button', { name: 'Close', exact: true });
  const closeCount = await closeBtn.count();
  for (let i = 0; i < closeCount; i++) {
    const btn = closeBtn.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => undefined);
    }
  }
}

/** Read enemy name from open detail panel (e.g. Rabbit). */
async function readEnemyNameFromDetailPanel(page: Page): Promise<string | null> {
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.count() > 0) {
    const heading = dialog.locator('h1, h2, h3').first();
    if (await heading.count() > 0) {
      const name = (await heading.innerText()).trim();
      if (name && !/^(STANCE|LOOT|FOOD|ENEMIES)$/i.test(name)) return name;
    }
  }

  const text = await pageText(page);
  const match = text.match(/\n([A-Za-z][A-Za-z' -]+)\s*\n\s*\d+\s+Combat EXP/i);
  return match?.[1]?.trim() ?? null;
}

/** Match stance option labels like "Balanced (All Stats)" from short name "Balanced". */
function stanceOptionMatches(label: string, stance: Stance): boolean {
  const normalized = label.trim().toLowerCase();
  const needle = stance.toLowerCase();
  return normalized.startsWith(needle) || normalized.includes(`(${needle}`) || normalized.includes(needle);
}

async function selectStanceFromNativeSelect(select: Locator, stance: Stance): Promise<boolean> {
  const options = select.locator('option');
  const count = await options.count();

  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const label = ((await opt.textContent()) ?? '').trim();
    if (!label || !stanceOptionMatches(label, stance)) continue;

    const value = await opt.getAttribute('value');
    try {
      if (value !== null && value !== '') {
        await select.selectOption(value, { timeout: 3000 });
      } else {
        await select.selectOption({ label }, { timeout: 3000 });
      }
      return true;
    } catch {
      try {
        await select.selectOption({ label }, { timeout: 3000 });
        return true;
      } catch {
        // try next matching option
      }
    }
  }

  // Fallback: keep default / first non-empty option rather than abort Battle.
  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const label = ((await opt.textContent()) ?? '').trim();
    if (!label) continue;
    const value = await opt.getAttribute('value');
    try {
      if (value !== null && value !== '') {
        await select.selectOption(value, { timeout: 3000 });
      } else {
        await select.selectOption({ label }, { timeout: 3000 });
      }
      return true;
    } catch {
      // leave default
    }
  }

  return false;
}

async function setStance(page: Page, stance: Stance): Promise<void> {
  try {
    const namedSelect = page.locator('select[name="location"]');
    if (await namedSelect.count() > 0) {
      await selectStanceFromNativeSelect(namedSelect.first(), stance);
      return;
    }

    const stanceSelect = page.locator('select').filter({
      hasText: /Balanced|Offensive|Defensive|Agile|Dexterous/i,
    });
    if (await stanceSelect.count() > 0) {
      await selectStanceFromNativeSelect(stanceSelect.first(), stance);
      return;
    }

    const combobox = page.getByRole('combobox').filter({
      hasText: /Balanced|Offensive|Defensive|Agile|Dexterous/i,
    });
    if (await combobox.count() > 0) {
      await combobox.first().click({ timeout: 3000 }).catch(() => undefined);
      const option = page.getByRole('option', { name: new RegExp(`^${stance}`, 'i') });
      if (await option.count() > 0) {
        await option.first().click({ timeout: 3000 }).catch(() => undefined);
      }
    }
  } catch {
    // Stance is best-effort — proceed with UI default and still click Battle.
  }
}

async function setMaxEnemies(page: Page, maxEnemies: number): Promise<void> {
  let maxInput = page.locator('input#max_enemies');
  if (await maxInput.count() === 0) {
    maxInput = page.locator('input[type="number"]');
  }
  if (await maxInput.count() > 0) {
    await maxInput.first().fill(String(maxEnemies));
  }
}

/** Cooked food preferred for pre-battle heal (weakest first per wiki). */
const COOKED_FOOD_PRIORITY = ['Cooked Cod', 'Cooked Salmon', 'Cooked Tuna'];
const COOKED_FOOD_PATTERN = /^Cooked /i;

export type BattleFoodResult =
  | { status: 'food_selected'; item: string; quantity: number }
  | { status: 'no_food' };

async function getBattleDetailPanel(page: Page): Promise<Locator> {
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.count() > 0 && await dialog.first().isVisible().catch(() => false)) {
    return dialog.first();
  }
  return page.locator('body');
}

function logBattleFood(result: BattleFoodResult): void {
  if (result.status === 'food_selected') {
    console.log(`[combat] food → ${result.item} x${result.quantity}`);
    return;
  }
  console.log('[combat] food → none available');
}

/** Use the battle Alpine component to add all owned stacks of the best cooked food. */
async function selectBattleFoodViaAlpine(page: Page): Promise<BattleFoodResult | null> {
  return page.evaluate((priority) => {
    const root = globalThis as {
      Alpine?: { $data: (el: unknown) => Record<string, unknown> };
      document?: { querySelectorAll: (selector: string) => Iterable<unknown> };
    };
    const alpine = root.Alpine;
    if (!alpine || !root.document) return null;

    let component: Record<string, unknown> | null = null;
    for (const node of root.document.querySelectorAll('[x-data]')) {
      try {
        const data = alpine.$data(node);
        if (data && typeof data.addFoodItem === 'function' && Array.isArray(data.food_items)) {
          component = data;
          break;
        }
      } catch {
        // skip nodes without Alpine data
      }
    }
    if (!component) return null;

    const entries = component.food_items as Array<Record<string, unknown>>;
    if (!entries.length) return { status: 'no_food' as const };

    const getName = (entry: Record<string, unknown>): string => {
      const item = entry.item as Record<string, unknown> | undefined;
      return String(item?.name ?? entry.name ?? '');
    };
    const getItem = (entry: Record<string, unknown>): Record<string, unknown> =>
      (entry.item as Record<string, unknown>) ?? entry;
    const getOwned = (entry: Record<string, unknown>): number => {
      const item = entry.item as Record<string, unknown> | undefined;
      const qty = entry.quantity ?? entry.owned ?? item?.quantity ?? 0;
      return Number(qty) || 0;
    };

    const cooked = entries.filter(
      (entry) => /^Cooked /i.test(getName(entry)) && getOwned(entry) > 0,
    );
    if (!cooked.length) return { status: 'no_food' as const };

    let chosen = cooked[0];
    for (const preferred of priority) {
      const match = cooked.find((entry) => getName(entry).toLowerCase() === preferred.toLowerCase());
      if (match) {
        chosen = match;
        break;
      }
    }

    const item = getItem(chosen);
    const quantity = getOwned(chosen);
    const name = getName(chosen);
    (component.addFoodItem as (item: Record<string, unknown>, qty: number) => void)(item, quantity);
    return { status: 'food_selected' as const, item: name, quantity };
  }, COOKED_FOOD_PRIORITY);
}

/** DOM fallback: find a cooked food row in the FOOD section and set quantity to max owned. */
async function selectBattleFoodViaDom(page: Page): Promise<BattleFoodResult | null> {
  const panel = await getBattleDetailPanel(page);
  const foodHeading = panel.getByText(/^FOOD$/i).first();
  if (await foodHeading.count() > 0 && await foodHeading.isVisible().catch(() => false)) {
    await foodHeading.click().catch(() => undefined);
  }

  const candidates: string[] = [...COOKED_FOOD_PRIORITY];
  const cookedLabels = panel.getByText(COOKED_FOOD_PATTERN);
  const labelCount = await cookedLabels.count();
  for (let i = 0; i < labelCount; i++) {
    const name = (await cookedLabels.nth(i).innerText()).trim();
    if (name && !candidates.includes(name)) candidates.push(name);
  }

  for (const name of candidates) {
    const nameEl = panel.getByText(name, { exact: true }).first();
    if (await nameEl.count() === 0 || !(await nameEl.isVisible().catch(() => false))) continue;

    const row = nameEl.locator(
      'xpath=ancestor::*[self::tr or self::li or contains(@class,"flex")][1]',
    );
    const qtyInput = row.locator('input[type="number"]');
    if (await qtyInput.count() > 0) {
      const maxAttr = await qtyInput.first().getAttribute('max');
      const placeholder = await qtyInput.first().getAttribute('placeholder');
      const parsed = Number(maxAttr ?? placeholder ?? 0);
      const quantity = parsed > 0 ? parsed : 999;
      await qtyInput.first().fill(String(quantity));
      return { status: 'food_selected', item: name, quantity };
    }

    const foodBtn = panel.getByRole('button', { name: new RegExp(name, 'i') });
    if (await foodBtn.count() > 0) {
      await foodBtn.first().click();
      return { status: 'food_selected', item: name, quantity: 1 };
    }

    await nameEl.click().catch(() => undefined);
    return { status: 'food_selected', item: name, quantity: 1 };
  }

  return null;
}

/**
 * Select cooked food on the pre-battle enemy detail panel (FOOD section).
 * Food raises effective HP and is auto-consumed; unused returns after battle.
 * Does not click-heal mid-fight.
 */
export async function selectBattleFood(page: Page): Promise<BattleFoodResult> {
  const alpineResult = await selectBattleFoodViaAlpine(page);
  if (alpineResult) {
    logBattleFood(alpineResult);
    return alpineResult;
  }

  const domResult = await selectBattleFoodViaDom(page);
  if (domResult) {
    logBattleFood(domResult);
    return domResult;
  }

  const none: BattleFoodResult = { status: 'no_food' };
  logBattleFood(none);
  return none;
}

/**
 * Click the ENEMIES NEARBY count button to open the enemy detail panel.
 * Post-Stop UI shows a numeric badge (e.g. 40), not creature card buttons.
 */
export async function openEnemiesNearbyPanel(page: Page): Promise<CombatStepResult> {
  try {
    if (await isEnemyDetailPanelOpen(page)) {
      return 'enemy_selected';
    }

    const countBtn = await findEnemiesNearbyCountButton(page);
    if (!countBtn) {
      return 'failed';
    }

    await dismissBlockingOverlays(page);
    await countBtn.click({ force: true, timeout: 5000 }).catch(() => undefined);
    await page
      .getByText(/^STANCE$/i)
      .first()
      .waitFor({ state: 'visible', timeout: COMBAT_UI_SETTLE_MS })
      .catch(() => undefined);

    if (await isEnemyDetailPanelOpen(page)) {
      return 'enemy_selected';
    }

    return 'failed';
  } catch {
    return 'failed';
  }
}

async function hasEnemySelectionReady(page: Page): Promise<boolean> {
  if (await isEnemyDetailPanelOpen(page)) return true;
  if (await findEnemiesNearbyCountButton(page)) return true;
  const cards = await collectEnemyCardButtons(page);
  if (cards.length > 0) return true;
  const text = await pageText(page);
  return /ENEMIES NEARBY/i.test(text);
}

/**
 * Ensure combat is in a hunt-ready state. Handles fresh Start Hunt, post-hunt Hunt More,
 * active hunts (Stop visible), and leftover enemy-select screens.
 */
export async function ensureHuntActive(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  await navigateTo(page, config, COMBAT_PATH);
  await waitForCombatUiSettled(page);

  if (await isButtonVisible(page, 'Start Hunt')) {
    await page.getByRole('button', { name: 'Start Hunt', exact: true }).first().click();
    const dialog = await handleReplaceDialog(page, allowInterrupt);
    if (dialog === 'no_action') return 'no_action';
    if (dialog === 'failed') return 'failed';
    return 'hunt_started';
  }

  if (await isButtonVisible(page, 'Hunt More')) {
    await page.getByRole('button', { name: 'Hunt More', exact: true }).first().click();
    const dialog = await handleReplaceDialog(page, allowInterrupt);
    if (dialog === 'no_action') return 'no_action';
    if (dialog === 'failed') return 'failed';
    return 'hunt_started';
  }

  if (await isButtonVisible(page, 'Stop')) {
    return 'hunt_already_active';
  }

  if (await hasEnemySelectionReady(page)) {
    return 'enemy_select_ready';
  }

  return 'failed';
}

/** @deprecated Use ensureHuntActive — kept for compatibility. */
export async function startHunt(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  return ensureHuntActive(page, config, allowInterrupt);
}

function parseHuntMetrics(text: string): {
  totalEnemiesFound?: number;
  enemiesRemaining?: number;
  bonusEnemies?: number;
} {
  const totalMatch = text.match(/Total Enemies Found[^\d]*(\d+)/i);
  const remainingMatch = text.match(/Enemies Remaining[^\d]*(\d+)/i);
  const bonusMatch = text.match(/Bonus Enemies[^\d]*(\d+)/i);

  return {
    totalEnemiesFound: totalMatch ? Number.parseInt(totalMatch[1], 10) : undefined,
    enemiesRemaining: remainingMatch ? Number.parseInt(remainingMatch[1], 10) : undefined,
    bonusEnemies: bonusMatch ? Number.parseInt(bonusMatch[1], 10) : undefined,
  };
}

/** Read hunt screen: metrics while hunting (Stop visible) and cards after Stop. */
export async function readHuntState(page: Page): Promise<HuntState> {
  const text = await pageText(page);
  const cardButtons = await collectEnemyCardButtons(page);
  const enemies = await enemyInfosFromButtons(cardButtons);
  const metrics = parseHuntMetrics(text);

  const defeatedMatch = text.match(/(\d+)\s+defeated/i);
  const defeatedCount = defeatedMatch ? Number.parseInt(defeatedMatch[1], 10) : 0;

  return {
    enemies,
    defeatedCount,
    ...metrics,
    pageText: text,
  };
}

/** Click Stop on hunt screen and confirm. */
export async function stopHunt(page: Page): Promise<CombatStepResult> {
  const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
  if (await stopBtn.count() === 0) {
    return 'no_action';
  }
  await stopBtn.first().click();

  const confirmStop = page.getByRole('button', { name: 'Stop', exact: true });
  if (await confirmStop.count() > 1) {
    await confirmStop.last().click();
  }

  return 'hunt_stopped';
}

/**
 * Open enemy detail (if needed), set stance/max, click Battle.
 * Post-Stop: count button → detail panel. Legacy: click creature card first.
 */
export async function configureAndBattle(
  page: Page,
  enemyIndex: number,
  maxEnemies: number,
  stance: Stance,
): Promise<CombatStepResult> {
  if (!(await isEnemyDetailPanelOpen(page))) {
    const opened = await openEnemiesNearbyPanel(page);
    if (opened !== 'enemy_selected') {
      const cardButtons = await collectEnemyCardButtons(page);
      if (cardButtons.length <= enemyIndex) {
        return 'failed';
      }
      await cardButtons[enemyIndex].click();
    }
  }

  await setStance(page, stance);
  await setMaxEnemies(page, maxEnemies);
  await selectBattleFood(page);

  const battleBtn = page.getByRole('button', { name: 'Battle', exact: true });
  if (await battleBtn.count() === 0) {
    return 'failed';
  }
  await battleBtn.first().click();

  return 'battle_started';
}

/** Read battle screen state if a fight is in progress. */
export async function readBattleState(page: Page): Promise<BattleState> {
  const text = await pageText(page);
  const inBattle =
    text.includes('Run Away') ||
    (text.includes('Battle') && text.includes('HP'));

  let playerHpPercent: number | undefined;
  const hpMatch = text.match(/(\d+)\s*%\s*HP/i) ?? text.match(/HP[:\s]*(\d+)%/i);
  if (hpMatch) {
    playerHpPercent = Number.parseInt(hpMatch[1], 10);
  }

  return { inBattle, playerHpPercent, pageText: text };
}

/** Click Run Away during an active battle. */
export async function runAway(page: Page): Promise<CombatStepResult> {
  const fleeBtn = page.getByRole('button', { name: 'Run Away', exact: true });
  if (await fleeBtn.count() === 0) {
    return 'no_action';
  }
  await fleeBtn.click();
  return 'fled';
}

/** Click Hunt More to repeat after a battle completes. */
export async function huntMore(
  page: Page,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  const huntMoreBtn = page.getByRole('button', { name: 'Hunt More', exact: true });
  if (await huntMoreBtn.count() === 0) {
    return 'no_action';
  }
  await huntMoreBtn.first().click();

  const dialog = await handleReplaceDialog(page, allowInterrupt);
  if (dialog === 'no_action') return 'no_action';
  if (dialog === 'failed') return 'failed';

  return 'hunt_more_clicked';
}

/**
 * Wait until hunt is active: Stop visible and hunt metrics or enemy cards appear.
 * During hunting, only metrics (Total Enemies Found) are shown — not card buttons.
 */
export async function waitForEnemies(
  page: Page,
  timeoutMs = 60_000,
): Promise<HuntState> {
  const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
  const huntMoreBtn = page.getByRole('button', { name: 'Hunt More', exact: true });

  await stopBtn
    .or(huntMoreBtn)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => undefined);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readHuntState(page);
    if (
      (state.totalEnemiesFound ?? 0) > 0 ||
      state.enemies.length > 0 ||
      state.defeatedCount > 0
    ) {
      return state;
    }
    if (await hasEnemySelectionReady(page)) {
      return state;
    }
    await page.waitForTimeout(500);
  }

  return readHuntState(page);
}

/**
 * After Stop: open ENEMIES NEARBY count panel or wait for legacy creature cards.
 * Returns HuntState with enemy name from detail panel when available.
 */
export async function prepareEnemyBattleSelection(
  page: Page,
  timeoutMs = 30_000,
): Promise<HuntState> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isEnemyDetailPanelOpen(page)) {
      const name = await readEnemyNameFromDetailPanel(page);
      const base = await readHuntState(page);
      if (name) {
        return { ...base, enemies: [{ name, index: 0 }] };
      }
      return base;
    }

    const countBtn = await findEnemiesNearbyCountButton(page);
    if (countBtn) {
      const opened = await openEnemiesNearbyPanel(page);
      if (opened === 'enemy_selected') {
        const name = await readEnemyNameFromDetailPanel(page);
        const base = await readHuntState(page);
        if (name) {
          return { ...base, enemies: [{ name, index: 0 }] };
        }
        return base;
      }
    }

    const state = await readHuntState(page);
    if (state.enemies.length > 0) {
      return state;
    }

    await page.waitForTimeout(500);
  }

  return readHuntState(page);
}

/** @deprecated Use prepareEnemyBattleSelection */
export async function waitForEnemyCards(
  page: Page,
  timeoutMs = 30_000,
): Promise<HuntState> {
  return prepareEnemyBattleSelection(page, timeoutMs);
}
