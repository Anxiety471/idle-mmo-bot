import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { GatherRestartResult } from '../types.js';
import { navigateTo } from '../browser.js';
import { getSkillConfig } from './skills.js';

/**
 * Minimal craft/smelting helper — only acts when Start is visibly enabled.
 * Skips unknown resource labels (playbook not confirmed).
 */

export async function trySmeltCoal(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<GatherRestartResult> {
  const skill = getSkillConfig('smelting');
  await navigateTo(page, config, skill.path);

  const pageText = await page.locator('body').innerText();
  if (pageText.includes('CURRENT ACTION')) {
    return 'already_busy';
  }

  const coalBtn = page.getByRole('button', { name: 'Coal Ore', exact: true })
    .or(page.getByText('Coal Ore', { exact: true }));
  if (await coalBtn.count() > 0) {
    await coalBtn.first().click().catch(() => undefined);
  }

  const startBtn = page.getByRole('button', { name: 'Start', exact: true });
  if (await startBtn.count() === 0) return 'failed';
  if (await startBtn.first().isDisabled()) return 'failed';

  await startBtn.first().click();

  const dialog = page.getByText('Start a new action?');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (allowInterrupt) {
      const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
      if (await startAnyway.count() > 0) {
        await startAnyway.click();
        return 'restarted';
      }
      return 'failed';
    }
    const closeButton = page.getByRole('button', { name: 'Close', exact: true });
    if (await closeButton.count() > 0) {
      await closeButton.click();
      return 'kept_current_action';
    }
    return 'another_action_active';
  }

  return 'restarted';
}
