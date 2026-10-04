import type { Locator, Page } from 'playwright';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { navigateTo } from '../browser.js';
import { waitForPageReady } from '../browser/page-ready.js';
import { ITEM_SLUG_MAP, KNOWN_INV_ITEMS } from '../snapshot/inventory-scrape.js';

/**
 * Round 7: vendor-sell a surplus gather stack from /inventory.
 *
 * Inventory tiles are icon-only (no item text), so the old getByText-based sell never
 * found Coal/Oak and sells stayed 0. Here the tile is located the same way the
 * inventory scraper counts it (img src slug / CDN meta / title / alt), marked with a
 * data attribute, then clicked. Every step logs the UI it saw so a miss is diagnosable.
 */

const MARK_ATTR = 'data-bot-sell-target';

/** Browser-side: mark the first inventory tile whose icon resolves to `item`. */
const MARK_TILE_SCRIPT = String.raw`([item, slugMap, known, attr]) => {
  document.querySelectorAll('[' + attr + ']').forEach((el) => el.removeAttribute(attr));
  const resolve = (key) => {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return null;
    if (slugMap[k]) return slugMap[k];
    const u = k.replace(/\s+/g, '_');
    if (slugMap[u]) return slugMap[u];
    const h = k.replace(/\s+/g, '-');
    if (slugMap[h]) return slugMap[h];
    for (const name of known) if (String(name).toLowerCase() === k) return name;
    return null;
  };
  const fromSrc = (src) => {
    const meta = String(src || '').match(/meta([A-Za-z0-9+/]+=*)/i);
    if (meta && meta[1]) {
      try {
        const decoded = atob(meta[1]).trim().toLowerCase().replace(/\.\w+$/i, '').replace(/[_\s]+/g, ' ').trim();
        const r = resolve(decoded);
        if (r) return r;
      } catch (_) {}
    }
    const file = String(src || '').split('/').pop().replace(/\.\w+$/i, '').toLowerCase();
    return resolve(file);
  };
  const tiles = Array.from(document.querySelectorAll('main button:has(img), [x-data*="inventory"] button:has(img), button:has(img)'));
  for (const btn of tiles) {
    const r = btn.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const img = btn.querySelector('img');
    const labels = [btn.getAttribute('title'), btn.getAttribute('aria-label'), img && img.getAttribute('alt')];
    let name = null;
    for (const l of labels) { const m = resolve(l); if (m) { name = m; break; } }
    if (!name && img) name = fromSrc(img.getAttribute('src'));
    if (name === item) {
      btn.setAttribute(attr, '1');
      return { found: true, text: (btn.textContent || '').trim().slice(0, 20) };
    }
  }
  return { found: false, tiles: tiles.length };
}`;

async function visibleButtonNames(page: Page, limit = 40): Promise<string[]> {
  try {
    const names = (await page.evaluate(`(() => Array.from(document.querySelectorAll('button, [role=button], a'))
      .filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40))
      .filter(Boolean))()`)) as string[];
    return names.slice(-limit);
  } catch {
    return [];
  }
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function shot(page: Page, config: AppConfig, tag: string): Promise<void> {
  void config;
  const dir = process.env.AUTOPILOT_LOG_DIR?.trim();
  if (!dir) return;
  const path = join(dir, `sell-${tag}-${Date.now()}.png`);
  await page.screenshot({ path }).catch(() => undefined);
  console.log(`[sell] screenshot ${path}`);
}

export type VendorSellResult = 'sold' | 'not_found' | 'no_sell_button' | 'no_confirm' | 'failed';

/** Quantity to sell: everything above `keep`, never negative. */
export function vendorSellQuantity(have: number, keep: number): number {
  if (!Number.isFinite(have) || have <= 0) return 0;
  return Math.max(0, Math.floor(have) - Math.max(0, Math.floor(keep)));
}

/**
 * Sell `qty` of `item` to the vendor. Returns 'sold' only after a confirm click.
 */
export async function sellItemToVendor(
  page: Page,
  config: AppConfig,
  item: string,
  qty: number,
): Promise<VendorSellResult> {
  if (qty <= 0) return 'not_found';
  try {
    await navigateTo(page, config, '/inventory');
    await waitForPageReady(page, 'inventory').catch(() => undefined);
    await page.waitForTimeout(1200);

    const mark = (await page.evaluate(
      `(${MARK_TILE_SCRIPT})(${JSON.stringify([item, ITEM_SLUG_MAP, KNOWN_INV_ITEMS, MARK_ATTR])})`,
    )) as { found: boolean; tiles?: number };
    if (!mark?.found) {
      console.log(`[sell] ${item} tile not found (tiles=${mark?.tiles ?? '?'})`);
      await shot(page, config, 'notile');
      return 'not_found';
    }
    await page.locator(`[${MARK_ATTR}]`).first().click({ timeout: 5000 });
    await page.waitForTimeout(900);

    const sellBtn = await firstVisible(
      page.getByRole('button', { name: /sell to vendor|^sell$|vendor/i }),
    );
    if (!sellBtn) {
      console.log(`[sell] ${item}: no Sell button; buttons=${JSON.stringify(await visibleButtonNames(page))}`);
      await shot(page, config, 'nosell');
      await page.keyboard.press('Escape').catch(() => undefined);
      return 'no_sell_button';
    }
    const sellLabel = (await sellBtn.innerText().catch(() => '')).trim();
    await sellBtn.click({ timeout: 5000 });
    await page.waitForTimeout(800);

    // Quantity dialog: fill the visible quantity input, clamped to its max.
    const qtyInput = await firstVisible(
      page.locator('input#quantity, input[name="quantity"], input[type="number"]'),
    );
    let filled = 'n/a';
    if (qtyInput) {
      const maxAttr = Number.parseInt((await qtyInput.getAttribute('max').catch(() => null)) ?? '', 10);
      const target = Number.isFinite(maxAttr) && maxAttr > 0 ? Math.min(qty, maxAttr) : qty;
      await qtyInput.fill(String(target)).catch(() => undefined);
      await qtyInput.dispatchEvent('input').catch(() => undefined);
      await qtyInput.dispatchEvent('change').catch(() => undefined);
      filled = `${target}${Number.isFinite(maxAttr) ? `/max ${maxAttr}` : ''}`;
      await page.waitForTimeout(300);
    }

    const confirm = await firstVisible(
      page.getByRole('button', { name: /^(sell|confirm|yes|ok)\b|sell for|sell \d/i }),
    );
    if (!confirm) {
      console.log(
        `[sell] ${item}: clicked "${sellLabel}" qty=${filled} but no confirm; buttons=${JSON.stringify(await visibleButtonNames(page))}`,
      );
      await shot(page, config, 'noconfirm');
      await page.keyboard.press('Escape').catch(() => undefined);
      return 'no_confirm';
    }
    const confirmLabel = (await confirm.innerText().catch(() => '')).trim();
    await confirm.click({ timeout: 5000 });
    await page.waitForTimeout(1200);
    console.log(`[sell] sold ${item} qty=${filled} via "${sellLabel}" → "${confirmLabel}"`);
    return 'sold';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[sell] ${item} failed: ${message.slice(0, 200)}`);
    return 'failed';
  }
}
