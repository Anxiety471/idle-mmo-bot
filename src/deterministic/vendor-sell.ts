import type { Locator, Page } from 'playwright';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import {
  decideSale,
  parseDetailQuantity,
  parseDetailType,
  parseSellPolicy,
  parseTileQuantity,
  parseTooltipName,
  type InventoryItem,
  type SellPolicy,
} from './sell-policy.js';

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

// ---------------------------------------------------------------------------
// Round 7 (user request): map the inventory and sell useless / surplus items.
// ---------------------------------------------------------------------------

const TILE_SELECTOR = 'main button:has(img)';

async function tooltipText(page: Page): Promise<string> {
  return (
    (await page
      .locator('.tippy-content:visible, [role="tooltip"]:visible')
      .first()
      .innerText()
      .catch(() => '')) || ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact gold from the inventory header coin tile tooltip ("17,192"). */
export async function readInventoryGold(page: Page): Promise<number | undefined> {
  const coin = page.locator(`${TILE_SELECTOR}:has(img[src*="gold_coin"])`).first();
  if ((await coin.count().catch(() => 0)) === 0) return undefined;
  await coin.hover({ timeout: 2000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const tip = await tooltipText(page);
  const fromTip = Number.parseInt(tip.replace(/[^\d]/g, ''), 10);
  await page.mouse.move(0, 0).catch(() => undefined);
  if (Number.isFinite(fromTip) && fromTip >= 0 && /\d/.test(tip)) return fromTip;
  const label = (await coin.innerText().catch(() => '')).trim();
  const fromLabel = parseTileQuantity(label);
  return fromLabel > 0 ? fromLabel : undefined;
}

export interface MappedTile extends InventoryItem {
  index: number;
}

/** Hover every inventory tile: tooltip name + tile quantity. Currency tiles (no "Level") skipped. */
export async function mapInventory(page: Page): Promise<MappedTile[]> {
  const tiles = page.locator(TILE_SELECTOR);
  const count = Math.min(await tiles.count().catch(() => 0), 120);
  const out: MappedTile[] = [];
  let lastTip = '';
  for (let i = 0; i < count; i++) {
    const tile = tiles.nth(i);
    if (!(await tile.isVisible().catch(() => false))) continue;
    // Tooltips lag a tile behind: park the mouse, hover, and wait for a fresh tooltip.
    await page.mouse.move(0, 0).catch(() => undefined);
    await page.waitForTimeout(150);
    await tile.hover({ timeout: 2000 }).catch(() => undefined);
    let tip = '';
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await page.waitForTimeout(150);
      tip = await tooltipText(page);
      if (tip && tip !== lastTip) break;
    }
    if (!tip || tip === lastTip) continue;
    lastTip = tip;
    if (!/\bLevel\s+\d+/i.test(tip)) continue; // gold / tokens / currency
    const name = parseTooltipName(tip);
    const qty = parseTileQuantity((await tile.innerText().catch(() => '')).trim());
    if (name) out.push({ index: i, name, qty });
  }
  await page.mouse.move(0, 0).catch(() => undefined);
  return out;
}

/** Open a tile's detail panel and read Type / exact Quantity (text after the item name). */
export async function readTileDetail(
  page: Page,
  tile: MappedTile,
): Promise<{ verified: boolean; type?: string; qty?: number }> {
  await page.locator(TILE_SELECTOR).nth(tile.index).click({ timeout: 4000 });
  await page.waitForTimeout(900);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  // The detail panel follows the grid's trailing "Empty" slots and starts with the item name.
  // If it does not start with the expected name the tile/name mapping is wrong: return
  // nothing so the caller never sells (a wrong click must not sell another stack).
  const lastEmpty = body.lastIndexOf(' Empty ');
  const detail = (lastEmpty >= 0 ? body.slice(lastEmpty + ' Empty '.length) : body).trimStart();
  if (!detail.startsWith(tile.name)) {
    const at = body.lastIndexOf(tile.name);
    if (lastEmpty >= 0 || at < 0) return { verified: false };
    const tail = body.slice(at, at + 800);
    return { verified: true, type: parseDetailType(tail), qty: parseDetailQuantity(tail) };
  }
  const slice = detail.slice(0, 800);
  return { verified: true, type: parseDetailType(slice), qty: parseDetailQuantity(slice) };
}

function logSale(record: Record<string, unknown>): void {
  const dir = process.env.AUTOPILOT_LOG_DIR?.trim();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'sales.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    /* logging only */
  }
}

export interface InventorySellSummary {
  sold: { item: string; qty: number; gold?: number }[];
  goldBefore?: number;
  goldAfter?: number;
}

/** Click the already-open detail's Sell to Vendor, set quantity, confirm. */
async function sellOpenDetail(page: Page, item: string, qty: number): Promise<VendorSellResult> {
  const sellBtn = await firstVisible(page.getByRole('button', { name: /sell to vendor/i }));
  if (!sellBtn) {
    console.log(`[sell] ${item}: no Sell to Vendor; buttons=${JSON.stringify(await visibleButtonNames(page, 15))}`);
    return 'no_sell_button';
  }
  await sellBtn.click({ timeout: 5000 });
  await page.waitForTimeout(800);
  const qtyInput = await firstVisible(
    page.locator('input#quantity, input[name="quantity"], input[type="number"]'),
  );
  if (!qtyInput) {
    console.log(`[sell] ${item}: no quantity input — not selling (would sell an unknown amount)`);
    await page.keyboard.press('Escape').catch(() => undefined);
    return 'no_confirm';
  }
  await qtyInput.fill(String(qty)).catch(() => undefined);
  await qtyInput.dispatchEvent('input').catch(() => undefined);
  await qtyInput.dispatchEvent('change').catch(() => undefined);
  await page.waitForTimeout(300);
  const filled = Number.parseInt((await qtyInput.inputValue().catch(() => '')) || '0', 10);
  if (filled !== qty) {
    console.log(`[sell] ${item}: quantity input shows ${filled}, wanted ${qty} — aborting`);
    await page.keyboard.press('Escape').catch(() => undefined);
    return 'no_confirm';
  }
  const confirm = await firstVisible(page.getByRole('button', { name: /^sell$/i }));
  if (!confirm) {
    console.log(`[sell] ${item}: no Sell confirm; buttons=${JSON.stringify(await visibleButtonNames(page, 15))}`);
    await page.keyboard.press('Escape').catch(() => undefined);
    return 'no_confirm';
  }
  await confirm.click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  return 'sold';
}

/**
 * Map /inventory, decide per item with the sell policy (keep-list, per-item keeps, type
 * Crafting only, quest-named drops kept), and vendor-sell the surplus. Logs every sale
 * with item, quantity and gold delta (also to AUTOPILOT_LOG_DIR/sales.jsonl).
 */
export async function sellUselessInventory(
  page: Page,
  config: AppConfig,
  options: { questTitles?: string[]; policy?: SellPolicy; maxSales?: number } = {},
): Promise<InventorySellSummary> {
  const policy = options.policy ?? parseSellPolicy();
  const maxSales = options.maxSales ?? 6;
  const summary: InventorySellSummary = { sold: [] };
  await navigateTo(page, config, '/inventory');
  await waitForPageReady(page, 'inventory').catch(() => undefined);
  await page.waitForTimeout(1500);

  summary.goldBefore = await readInventoryGold(page);
  const tiles = await mapInventory(page);
  console.log(
    `[sell] inventory map (gold=${summary.goldBefore ?? '?'}): ` +
      tiles.map((t) => `${t.name} x${t.qty}`).join(', '),
  );

  for (const tile of tiles) {
    if (summary.sold.length >= maxSales) break;
    // Cheap pre-check (keep-list / Oak / per-item keep) before opening the detail panel.
    const pre = decideSale({ ...tile, type: 'crafting' }, policy, options.questTitles);
    if (pre.sell <= 0) {
      console.log(`[sell] keep ${tile.name} x${tile.qty} (${pre.reason})`);
      continue;
    }
    // Indices shift after a stack sells out; re-map to find this item again.
    const fresh = (await mapInventory(page)).find((t) => t.name === tile.name);
    if (!fresh) continue;
    const detail = await readTileDetail(page, fresh).catch(
      () => ({ verified: false }) as { verified: boolean; type?: string; qty?: number },
    );
    if (!detail.verified || detail.qty === undefined) {
      console.log(`[sell] skip ${fresh.name}: detail panel did not confirm the item/quantity`);
      await page.keyboard.press('Escape').catch(() => undefined);
      continue;
    }
    const item: InventoryItem = { name: fresh.name, qty: detail.qty, type: detail.type };
    const decision = decideSale(item, policy, options.questTitles);
    if (decision.sell <= 0) {
      console.log(`[sell] keep ${item.name} x${item.qty} type=${item.type ?? '?'} (${decision.reason})`);
      await page.keyboard.press('Escape').catch(() => undefined);
      continue;
    }
    const before = await readInventoryGold(page);
    // Re-open and re-verify the detail right before selling (hovering the coin moved focus).
    const again = await readTileDetail(page, fresh).catch(() => ({ verified: false }) as { verified: boolean; qty?: number });
    if (!again.verified || again.qty !== item.qty) {
      console.log(`[sell] skip ${item.name}: re-check failed before Sell (verified=${again.verified} qty=${again.qty})`);
      await page.keyboard.press('Escape').catch(() => undefined);
      continue;
    }
    const result = await sellOpenDetail(page, item.name, decision.sell);
    if (result !== 'sold') {
      logSale({ item: item.name, qty: decision.sell, result, type: item.type });
      continue;
    }
    await navigateTo(page, config, '/inventory');
    await waitForPageReady(page, 'inventory').catch(() => undefined);
    await page.waitForTimeout(1200);
    const after = await readInventoryGold(page);
    const gold = before !== undefined && after !== undefined ? after - before : undefined;
    summary.sold.push({ item: item.name, qty: decision.sell, gold });
    console.log(
      `[sell] SOLD ${item.name} x${decision.sell} (type=${item.type ?? '?'}, ${decision.reason}) ` +
        `for ${gold !== undefined ? `+${gold}` : '?'} gold (gold ${before ?? '?'} → ${after ?? '?'})`,
    );
    logSale({ item: item.name, qty: decision.sell, gold, goldBefore: before, goldAfter: after, type: item.type, reason: decision.reason });
  }
  summary.goldAfter = await readInventoryGold(page);
  const total = summary.sold.reduce((sum, s) => sum + (s.gold ?? 0), 0);
  console.log(
    `[sell] done: ${summary.sold.length} sale(s), +${total} gold (gold ${summary.goldBefore ?? '?'} → ${summary.goldAfter ?? '?'})`,
  );
  return summary;
}
