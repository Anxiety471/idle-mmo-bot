import type { Page } from 'playwright';

export const PAGE_READY_TIMEOUT_MS = 8_000;

export type PageReadyKind = 'inventory' | 'merchant' | 'profile';

const INVENTORY_GRID_SELECTOR =
  'main button:has(img), [x-data*="inventory"] button:has(img), [data-inventory-grid] button:has(img)';

async function waitNetworkSettled(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
}

async function waitInventoryGridReady(page: Page, timeoutMs: number): Promise<boolean> {
  const grid = page.locator(INVENTORY_GRID_SELECTOR);
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    await waitNetworkSettled(page, Math.min(2_000, timeoutMs));
    const count = await grid.count().catch(() => 0);
    const visible = count > 0 ? await grid.first().isVisible().catch(() => false) : false;
    if (visible && count > 0) {
      if (count === lastCount) {
        stable += 1;
        if (stable >= 1) return true;
      } else {
        stable = 0;
        lastCount = count;
      }
    }
    await page.waitForTimeout(200);
  }
  return (await grid.count().catch(() => 0)) > 0;
}

async function waitMerchantReady(page: Page, timeoutMs: number): Promise<boolean> {
  await waitNetworkSettled(page, Math.min(2_000, timeoutMs));
  const melriel = page
    .getByRole('button', { name: /General Goods|Melriel/i })
    .or(page.getByText('Melriel', { exact: false }));
  try {
    await melriel.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function waitProfileReady(page: Page, timeoutMs: number): Promise<boolean> {
  await waitNetworkSettled(page, Math.min(2_000, timeoutMs));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText().catch(() => '');
    if (/Combat\s*(?:Lv\.?)?\s*\d+/i.test(text)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/**
 * Bounded readiness wait: brief network idle plus a page-specific anchor selector.
 */
export async function waitForPageReady(
  page: Page,
  kind: PageReadyKind,
  timeoutMs = PAGE_READY_TIMEOUT_MS,
): Promise<boolean> {
  switch (kind) {
    case 'inventory':
      return waitInventoryGridReady(page, timeoutMs);
    case 'merchant':
      return waitMerchantReady(page, timeoutMs);
    case 'profile':
      return waitProfileReady(page, timeoutMs);
    default:
      return false;
  }
}

/** Locator for inventory item slots (icon buttons inside the bag grid). */
export function inventoryGridLocator(page: Page) {
  return page.locator(INVENTORY_GRID_SELECTOR);
}
