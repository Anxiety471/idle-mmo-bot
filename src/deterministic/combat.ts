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

async function hasEnemySelectionReady(page: Page): Promise<boolean> {
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

/** Select enemy card, set max enemies and stance, then click Battle. */
export async function configureAndBattle(
  page: Page,
  enemyIndex: number,
  maxEnemies: number,
  stance: Stance,
): Promise<CombatStepResult> {
  const cardButtons = await collectEnemyCardButtons(page);
  if (cardButtons.length <= enemyIndex) {
    return 'failed';
  }
  await cardButtons[enemyIndex].click();

  const maxInput = page.locator('input#max_enemies');
  if (await maxInput.count() > 0) {
    await maxInput.fill(String(maxEnemies));
  }

  const stanceSelect = page.locator('select[name="location"]');
  if (await stanceSelect.count() > 0) {
    await stanceSelect.selectOption({ label: stance });
  }

  const battleBtn = page.getByRole('button', { name: 'Battle', exact: true });
  if (await battleBtn.count() === 0) {
    return 'failed';
  }
  await battleBtn.click();

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

/** Wait for enemy card buttons after Stop (Battle selection phase). */
export async function waitForEnemyCards(
  page: Page,
  timeoutMs = 30_000,
): Promise<HuntState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readHuntState(page);
    if (state.enemies.length > 0) {
      return state;
    }
    await page.waitForTimeout(500);
  }
  return readHuntState(page);
}
