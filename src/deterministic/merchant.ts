import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { MerchantStepResult } from '../types.js';
import { navigateTo } from '../browser.js';

/**
 * Deterministic merchant purchase helpers.
 *
 * Flow from playbook: /merchants → General Goods → Cheap Bait (2g).
 * UI may change — update selectors when flows break.
 * Never auto-purchase unless explicitly requested by CLI/config.
 */

const MERCHANTS_PATH = '/merchants';
const GENERAL_GOODS = 'General Goods';
const CHEAP_BAIT = 'Cheap Bait';

/** Buy a small quantity of Cheap Bait (default 1). */
export async function buyCheapBait(
  page: Page,
  config: AppConfig,
  quantity = 1,
): Promise<MerchantStepResult> {
  await navigateTo(page, config, MERCHANTS_PATH);

  const category = page
    .getByRole('button', { name: GENERAL_GOODS, exact: true })
    .or(page.getByText(GENERAL_GOODS, { exact: true }));
  if (await category.count() > 0) {
    await category.first().click();
  }

  const baitItem = page.getByText(CHEAP_BAIT, { exact: true });
  if (await baitItem.count() === 0) {
    return 'failed';
  }
  await baitItem.first().click();

  const qtyInput = page.locator('input[type="number"]');
  if (await qtyInput.count() > 0) {
    await qtyInput.first().fill(String(quantity));
  }

  const buyButton = page.getByRole('button', { name: 'Buy', exact: true });
  if (await buyButton.count() === 0) {
    return 'failed';
  }
  await buyButton.first().click();

  const confirm = page.getByRole('button', { name: /^(Confirm|Purchase)$/i });
  if (await confirm.count() > 0) {
    await confirm.first().click();
  }

  return 'purchased';
}
