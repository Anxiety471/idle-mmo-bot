import type { Page } from 'playwright';
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

async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/** Navigate to combat and click Start Hunt. */
export async function startHunt(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  await navigateTo(page, config, COMBAT_PATH);

  const startHuntBtn = page.getByRole('button', { name: 'Start Hunt', exact: true });
  if (await startHuntBtn.count() === 0) {
    return 'failed';
  }
  await startHuntBtn.click();

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

/** Read visible enemies from hunt screen (button.h-24 cards). */
export async function readHuntState(page: Page): Promise<HuntState> {
  const text = await pageText(page);
  const cards = page.locator('button.h-24');
  const count = await cards.count();
  const enemies: EnemyInfo[] = [];

  for (let i = 0; i < count; i++) {
    const name = (await cards.nth(i).innerText()).trim().split('\n')[0] ?? `Enemy ${i}`;
    enemies.push({ name, index: i });
  }

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
  const cards = page.locator('button.h-24');
  if (await cards.count() <= enemyIndex) {
    return 'failed';
  }
  await cards.nth(enemyIndex).click();

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

/** Wait until at least one enemy card is visible. */
export async function waitForEnemies(
  page: Page,
  timeoutMs = 60_000,
): Promise<HuntState> {
  const cards = page.locator('button.h-24');
  await cards.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => undefined);
  return readHuntState(page);
}
