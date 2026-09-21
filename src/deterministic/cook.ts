import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { GatherRestartResult } from '../types.js';
import { navigateTo } from '../browser.js';
import { getSkillConfig } from './skills.js';

/**
 * Cook Cod into Cooked Cod for pre-battle food (effective HP heal).
 * Recipe on /skills/view/cooking: button label like
 * "Cooked Cod Lv. 1 2 EXP 8 s 1 x Cod 1 x Coal Ore".
 */
export async function tryCookCod(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<GatherRestartResult> {
  const skill = getSkillConfig('cooking');
  await navigateTo(page, config, skill.path);
  await page.waitForTimeout(800);

  const pageText = await page.locator('body').innerText();
  if (pageText.includes('CURRENT ACTION')) {
    return 'already_busy';
  }

  // Accessible name is the full card text — match by prefix, then pick a real-sized card.
  const recipe = page.getByRole('button', { name: /Cooked Cod/i });
  let clicked = false;
  const count = await recipe.count();
  for (let i = 0; i < count; i++) {
    const btn = recipe.nth(i);
    const box = await btn.boundingBox().catch(() => null);
    if (!box || box.width < 40 || box.height < 20) continue;
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.click({ force: true, timeout: 5000 });
    clicked = true;
    break;
  }

  if (!clicked) {
    console.log('[cook] Cooked Cod recipe card not found');
    return 'failed';
  }

  await page.waitForTimeout(500);

  const startBtn = page.getByRole('button', { name: 'Start', exact: true });
  if ((await startBtn.count()) === 0) {
    console.log('[cook] Start button missing after selecting Cooked Cod');
    return 'failed';
  }
  if (await startBtn.first().isDisabled()) {
    console.log('[cook] Start disabled — need Cod + Coal Ore');
    return 'missing_requirement';
  }

  await startBtn.first().click();

  const dialog = page.getByText('Start a new action?');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (allowInterrupt) {
      const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
      if ((await startAnyway.count()) > 0) {
        await startAnyway.click();
        return 'restarted';
      }
      return 'failed';
    }
    const closeButton = page.getByRole('button', { name: 'Close', exact: true });
    if ((await closeButton.count()) > 0) {
      await closeButton.click();
      return 'kept_current_action';
    }
    return 'another_action_active';
  }

  return 'restarted';
}
