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
  'Cooked Cod',
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

/**
 * Careful early-playbook sell: vendor-sell a small batch of excess mats.
 * Keeps a floor of Coal Ore for cooking and never sells Cooked Cod / Cod / Bait.
 * Market price-aware reader is a follow-up — this is the conservative stub.
 */
export async function sellHalfCareful(
  page: Page,
  config: AppConfig,
  options: {
    itemHints?: string[];
    keepCoal?: number;
    keepOak?: number;
    keepCod?: number;
    keepCookedCod?: number;
    maxStacks?: number;
  } = {},
): Promise<InventoryStepResult | 'sold_partial'> {
  const keepCoal = options.keepCoal ?? 15;
  const keepOak = options.keepOak ?? 5;
  const keepCod = options.keepCod ?? 1;
  const keepCookedCod = options.keepCookedCod ?? 1;
  const maxStacks = options.maxStacks ?? 2;
  const hints = options.itemHints ?? ['Burnt Cod', 'Burnt Fish', 'Burnt Salmon', 'Oak Log', 'Coal Ore'];

  try {
    await navigateTo(page, config, INVENTORY_PATH);
    await page.waitForTimeout(800);

    let sold = 0;
    for (const item of hints) {
      if (sold >= maxStacks) break;
      if (item === 'Cheap Bait') {
        continue;
      }

      // Prefer clicking slots then reading detail panel (icon-only inventory).
      const detailHint = page.getByText(item, { exact: false });
      const itemNode = page.getByText(item, { exact: true });
      if ((await itemNode.count()) === 0 && (await detailHint.count()) === 0) {
        // Try clicking non-Empty inventory buttons and check detail text.
        const buttons = page.getByRole('button');
        const count = await buttons.count();
        let found = false;
        for (let i = 0; i < Math.min(count, 80); i++) {
          const label = (await buttons.nth(i).innerText().catch(() => '')).trim();
          if (!label || /^Empty$/i.test(label) || label.length > 12) continue;
          // Quantity-only badges like "25" / "1.2K"
          if (!/^(\d+(?:\.\d+)?[kK]?)$/.test(label) && label.length > 6) continue;
          await buttons.nth(i).click({ timeout: 2000 }).catch(() => undefined);
          await page.waitForTimeout(300);
          const body = await page.locator('body').innerText();
          if (body.includes(item)) {
            found = true;
            break;
          }
        }
        if (!found) continue;
      } else if (await itemNode.count() > 0) {
        await itemNode.first().click({ timeout: 5000 }).catch(() => undefined);
      }

      const body = await page.locator('body').innerText();
      if (item === 'Coal Ore' || /Coal/i.test(item)) {
        const coalMatch = body.match(/Coal(?:\s*Ore)?[^\d]{0,20}(\d+)/i);
        const qty = coalMatch ? Number.parseInt(coalMatch[1], 10) : 0;
        if (Number.isFinite(qty) && qty <= keepCoal) {
          console.log(`[inventory] keep Coal floor ${keepCoal} (have ${qty}) — skip sell`);
          continue;
        }
      }
      if (item === 'Oak Log' || /Oak/i.test(item)) {
        const oakMatch = body.match(/Oak(?:\s*Log)?[^\d]{0,20}(\d+)/i);
        const qty = oakMatch ? Number.parseInt(oakMatch[1], 10) : 0;
        if (Number.isFinite(qty) && qty <= keepOak) {
          console.log(`[inventory] keep Oak floor ${keepOak} (have ${qty}) — skip sell`);
          continue;
        }
      }
      if (item === 'Cooked Cod' || item === 'Cod' || item === 'Raw Cod') {
        const codMatch = body.match(/(?:Cooked\s+)?Cod[^\d]{0,20}(\d+)/i);
        const qty = codMatch ? Number.parseInt(codMatch[1], 10) : 0;
        const floor = item === 'Cooked Cod' ? keepCookedCod : keepCod;
        if (Number.isFinite(qty) && qty <= floor) {
          console.log(`[inventory] keep ${item} floor ${floor} (have ${qty}) — skip sell`);
          continue;
        }
      }

      const sellBtn = page.getByRole('button', { name: SELL_VENDOR_PATTERN });
      if (await sellBtn.count() === 0) continue;
      if (!(await sellBtn.first().isVisible().catch(() => false))) continue;
      await sellBtn.first().click({ timeout: 5000, force: true }).catch(() => undefined);
      await confirmSell(page);
      sold += 1;
      console.log(`[inventory] sellHalfCareful sold stack of ${item}`);
    }

    if (sold > 0) return 'sold';
    // Fall back to configured junk list
    const junk = await sellJunkToVendor(page, config, ['Burnt Cod', 'Burnt Fish', 'Burnt Salmon']);
    return junk;
  } catch {
    return 'failed';
  }
}
