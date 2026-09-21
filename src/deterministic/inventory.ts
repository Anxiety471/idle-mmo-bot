import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { InventoryStepResult } from '../types.js';
import { navigateTo } from '../browser.js';

const INVENTORY_PATH = '/inventory';
const SELL_VENDOR_PATTERN = /sell to vendor/i;
const SELL_CONFIRM_PATTERN = /^(Confirm|Yes|Sell|OK)$/i;

const PROTECTED_ITEMS = new Set([
  'Oak Log',
  'Yew Log',
  'Coal Ore',
  'Tin Ore',
  'Cheap Bait',
  'Cod',
  'Salmon',
  'Tuna',
]);

async function confirmSell(page: Page): Promise<void> {
  const confirm = page.getByRole('button', { name: SELL_CONFIRM_PATTERN });
  if (await confirm.count() > 0) {
    await confirm.first().click({ timeout: 3000 }).catch(() => undefined);
  }
}

/**
 * Sell configured junk items via Sell to Vendor. Skips protected mats.
 */
export async function sellJunkToVendor(
  page: Page,
  config: AppConfig,
  junkItems: string[],
): Promise<InventoryStepResult> {
  try {
    await navigateTo(page, config, INVENTORY_PATH);

    for (const item of junkItems) {
      if (PROTECTED_ITEMS.has(item)) continue;

      const itemNode = page.getByText(item, { exact: true });
      if (await itemNode.count() === 0) continue;
      await itemNode.first().click({ timeout: 5000 }).catch(() => undefined);

      const sellBtn = page.getByRole('button', { name: SELL_VENDOR_PATTERN });
      if (await sellBtn.count() === 0) continue;
      if (!(await sellBtn.first().isVisible().catch(() => false))) continue;

      await sellBtn.first().click({ timeout: 5000, force: true }).catch(() => undefined);
      await confirmSell(page);
      return 'sold';
    }

    return 'no_action';
  } catch {
    return 'failed';
  }
}

/** @deprecated Use sellJunkToVendor with explicit junk list. */
export async function sellJunk(page: Page, config: AppConfig): Promise<InventoryStepResult> {
  const raw = process.env.JUNK_SELL_ITEMS?.trim();
  const items = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : ['Burnt Cod', 'Burnt Fish'];
  return sellJunkToVendor(page, config, items);
}
