import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { MerchantStepResult } from '../types.js';
import { navigateTo } from '../browser.js';

/**
 * Buy Cheap Bait from Melriel (General Goods) at /merchants.
 * Flow: merchants → Melriel → Cheap Bait → quantity → Purchase for N
 */

const MERCHANTS_PATH = '/merchants';

async function dismissMerchantDialogue(page: Page): Promise<void> {
  const lookAround = page.getByText("I'll have a look around.", { exact: true });
  if (await lookAround.count() > 0 && (await lookAround.first().isVisible().catch(() => false))) {
    await lookAround.first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

async function openMelriel(page: Page): Promise<boolean> {
  // Prefer visible General Goods / Melriel row (avoid hidden sm:hidden spans).
  for (const pattern of [/General Goods/i, /Melriel/i]) {
    const buttons = page.getByRole('button', { name: pattern });
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const box = await btn.boundingBox().catch(() => null);
      if (!box || box.width < 8 || box.height < 8) continue;
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.click({ force: true, timeout: 8000 });
      await page.waitForTimeout(1000);
      const body = await page.locator('body').innerText();
      if (/Cheap Bait/i.test(body) || /MELRIEL/i.test(body)) return true;
    }
  }
  // Fallback: force-click any exact text match (may include hidden labels).
  for (const label of ['Melriel', 'General Goods']) {
    const el = page.getByText(label, { exact: true });
    if ((await el.count()) === 0) continue;
    await el.first().click({ force: true, timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    const body = await page.locator('body').innerText();
    if (/Cheap Bait/i.test(body) || /MELRIEL/i.test(body)) return true;
  }
  return false;
}

/** Buy a small quantity of Cheap Bait (default 1). */
export async function buyCheapBait(
  page: Page,
  config: AppConfig,
  quantity = 1,
): Promise<MerchantStepResult> {
  try {
    await navigateTo(page, config, MERCHANTS_PATH);
    await page.waitForTimeout(1000);
    await dismissMerchantDialogue(page);

    if (!(await openMelriel(page))) {
      console.log('[merchant] Melriel / General Goods not found');
      return 'failed';
    }

    const baitItem = page.getByRole('button', { name: /Cheap Bait/i })
      .or(page.getByText('Cheap Bait', { exact: true }));
    if (await baitItem.count() === 0) {
      console.log('[merchant] Cheap Bait not listed');
      return 'failed';
    }
    await baitItem.first().click({ force: true, timeout: 8000 });
    await page.waitForTimeout(800);

    const qtyInput = page.locator('input[name="quantity"], input[type="number"]');
    if (await qtyInput.count() > 0) {
      await qtyInput.first().fill(String(quantity));
    }

    const purchase = page.getByRole('button', { name: /Purchase for/i })
      .or(page.getByRole('button', { name: 'Buy', exact: true }))
      .or(page.getByRole('button', { name: 'Purchase', exact: true }));
    if (await purchase.count() === 0) {
      console.log('[merchant] Purchase button missing');
      return 'failed';
    }
    await purchase.first().click({ force: true, timeout: 8000 });
    await page.waitForTimeout(500);

    const confirm = page.getByRole('button', { name: /^(Confirm|Purchase)$/i });
    if (await confirm.count() > 0) {
      await confirm.first().click({ force: true, timeout: 5000 }).catch(() => undefined);
    }

    console.log(`[merchant] Purchased Cheap Bait x${quantity}`);
    return 'purchased';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[merchant] buyCheapBait failed: ${message}`);
    return 'failed';
  }
}
