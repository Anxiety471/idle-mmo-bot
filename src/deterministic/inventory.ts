import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { InventoryStepResult } from '../types.js';
import { navigateTo } from '../browser.js';

/**
 * Best-effort inventory helpers.
 * UI may change — update selectors when sell flows break.
 */

const SELL_JUNK_PATTERN = /sell\s*(all\s*)?junk/i;
const SELL_CONFIRM_PATTERN = /^(Confirm|Yes|Sell|OK)$/i;

async function trySellOnPage(page: Page): Promise<boolean> {
  const sellBtn = page.getByRole('button', { name: SELL_JUNK_PATTERN });
  if (await sellBtn.count() === 0) return false;
  if (!(await sellBtn.first().isVisible().catch(() => false))) return false;

  await sellBtn.first().click({ timeout: 5000, force: true }).catch(() => undefined);

  const confirm = page.getByRole('button', { name: SELL_CONFIRM_PATTERN });
  if (await confirm.count() > 0) {
    await confirm.first().click({ timeout: 3000 }).catch(() => undefined);
  }

  return true;
}

/** Navigate to inventory/merchants and sell junk when the button is visible. */
export async function sellJunk(page: Page, config: AppConfig): Promise<InventoryStepResult> {
  try {
    for (const path of ['/inventory', '/merchants']) {
      await navigateTo(page, config, path);
      if (await trySellOnPage(page)) {
        return 'sold';
      }
    }
    return 'no_action';
  } catch {
    return 'failed';
  }
}
