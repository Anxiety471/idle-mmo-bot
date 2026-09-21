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
 */

const COMBAT_PATH = '/combat/battle';
/** Max wait for async combat controls after domcontentloaded (~3–4s observed). */
const COMBAT_UI_SETTLE_MS = 10_000;

/** Legacy playbook selector; UI may use other Tailwind height classes now. */
const ENEMY_CARD_HEIGHT_CLASSES = ['h-24', 'h-20', 'h-28', 'h-32'];

const ACTION_BUTTON_PATTERN =
  /^(Start Hunt|Stop|Battle|Run Away|Hunt More|Close|Start anyway|Create|Invites|Talk|Overview|Turn In)$/i;

async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/** Collect visible enemy card buttons using layered selectors (legacy h-24 → Lv. text → heuristic). */
async function collectEnemyCardButtons(page: Page): Promise<Locator[]> {
  for (const cls of ENEMY_CARD_HEIGHT_CLASSES) {
    const cards = page.locator(`button.${cls}`);
    const visible = await filterVisibleEnemyButtons(cards);
    if (visible.length > 0) return visible;
  }

  const withLevel = page.getByRole('button').filter({ hasText: /\bLv\.?\s*\d+/i });
  const levelVisible = await filterVisibleEnemyButtons(withLevel);
  if (levelVisible.length > 0) return levelVisible;

  // Heuristic: multi-line stat cards on hunt screen (exclude known action buttons).
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  const heuristic: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible())) continue;
    const text = (await btn.innerText()).trim();
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    if (!firstLine || ACTION_BUTTON_PATTERN.test(firstLine)) continue;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2 && !/\d/.test(text)) continue;
    heuristic.push(btn);
  }
  return heuristic;
}

async function filterVisibleEnemyButtons(locator: Locator): Promise<Locator[]> {
  const count = await locator.count();
  const visible: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const btn = locator.nth(i);
    if (!(await btn.isVisible())) continue;
    const firstLine = (await btn.innerText()).trim().split('\n')[0]?.trim() ?? '';
    if (firstLine && ACTION_BUTTON_PATTERN.test(firstLine)) continue;
    visible.push(btn);
  }
  return visible;
}

async function enemyInfosFromButtons(buttons: Locator[]): Promise<EnemyInfo[]> {
  const enemies: EnemyInfo[] = [];
  for (let i = 0; i < buttons.length; i++) {
    const text = (await buttons[i].innerText()).trim();
    const name = text.split('\n')[0]?.trim() ?? `Enemy ${i}`;
    enemies.push({ name, index: i });
  }
  return enemies;
}

/** Navigate to combat and click Start Hunt. */
export async function startHunt(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  await navigateTo(page, config, COMBAT_PATH);

  const startHuntBtn = page.getByRole('button', { name: 'Start Hunt', exact: true });
  const visible = await startHuntBtn
    .first()
    .waitFor({ state: 'visible', timeout: COMBAT_UI_SETTLE_MS })
    .catch(() => null);

  if (!visible && (await startHuntBtn.count()) === 0) {
    return 'failed';
  }

  await startHuntBtn.first().click();

  const dialog = page.getByText('Start a new action?');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (allowInterrupt) {
      const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
      if (await startAnyway.count() > 0) {
        await startAnyway.click();
        return 'hunt_started';
      }
      return 'failed';
    }
    const closeButton = page.getByRole('button', { name: 'Close', exact: true });
    if (await closeButton.count() > 0) {
      await closeButton.click();
      return 'no_action';
    }
  }

  return 'hunt_started';
}

/** Read visible enemies from hunt screen. */
export async function readHuntState(page: Page): Promise<HuntState> {
  const text = await pageText(page);
  const cardButtons = await collectEnemyCardButtons(page);
  const enemies = await enemyInfosFromButtons(cardButtons);

  const defeatedMatch = text.match(/(\d+)\s+defeated/i);
  const defeatedCount = defeatedMatch ? Number.parseInt(defeatedMatch[1], 10) : 0;

  return { enemies, defeatedCount, pageText: text };
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
export async function huntMore(page: Page): Promise<CombatStepResult> {
  const huntMoreBtn = page.getByRole('button', { name: 'Hunt More', exact: true });
  if (await huntMoreBtn.count() === 0) {
    return 'no_action';
  }
  await huntMoreBtn.click();
  return 'hunt_more_clicked';
}

/**
 * Wait until hunt is active: Stop visible and enemies or defeated count appear.
 * Enemy cards may not use button.h-24 anymore — layered detection in readHuntState.
 */
export async function waitForEnemies(
  page: Page,
  timeoutMs = 60_000,
): Promise<HuntState> {
  const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
  await stopBtn.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => undefined);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readHuntState(page);
    if (state.enemies.length > 0 || state.defeatedCount > 0) {
      return state;
    }
    await page.waitForTimeout(500);
  }

  return readHuntState(page);
}
