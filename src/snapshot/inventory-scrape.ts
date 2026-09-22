import type { Page } from 'playwright';

/** Items the early playbook and sell flows care about. Longer names first for substring matching. */
export const KNOWN_INV_ITEMS = [
  'Cooked Salmon',
  'Burnt Salmon',
  'Cooked Tuna',
  'Cooked Cod',
  'Burnt Cod',
  'Raw Cod',
  'Cheap Bait',
  'Coal Ore',
  'Oak Log',
  'Yew Log',
  'Salmon',
  'Tuna',
  'Coal',
  'Cod',
];

/** Map CDN / asset filename slugs to canonical item names. */
export const ITEM_SLUG_MAP: Record<string, string> = {
  'oak-log': 'Oak Log',
  oak_log: 'Oak Log',
  'coal-ore': 'Coal Ore',
  coal_ore: 'Coal Ore',
  'cheap-bait': 'Cheap Bait',
  cheap_bait: 'Cheap Bait',
  'raw-cod': 'Raw Cod',
  raw_cod: 'Raw Cod',
  'cooked-cod': 'Cooked Cod',
  cooked_cod: 'Cooked Cod',
  'burnt-cod': 'Burnt Cod',
  burnt_cod: 'Burnt Cod',
  'cooked-salmon': 'Cooked Salmon',
  cooked_salmon: 'Cooked Salmon',
  'burnt-salmon': 'Burnt Salmon',
  burnt_salmon: 'Burnt Salmon',
  'cooked-tuna': 'Cooked Tuna',
  cooked_tuna: 'Cooked Tuna',
  'yew-log': 'Yew Log',
  yew_log: 'Yew Log',
  cod: 'Cod',
  coal: 'Coal',
  salmon: 'Salmon',
  tuna: 'Tuna',
};

const CHROME_ITEM_DENY = /code of conduct|cookies|credits|monetisation/i;
const SLOT_SKIP_LABEL =
  /^(empty|sort|filter|sell|vendor|bank|market|quest|profile|combat|close|cancel|confirm|yes|no|ok)$/i;

/** Parse stack counts like `25`, `1.2K`, `1,234`. */
export function parseQuantityString(raw: string | null | undefined): number {
  if (!raw) return 0;
  const t = String(raw).trim().replace(/,/g, '');
  const mk = t.match(/^(\d+(?:\.\d+)?)[kK]$/);
  if (mk) return Math.round(Number.parseFloat(mk[1]) * 1000);
  const m = t.match(/^(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** Match a scraped label to a known inventory item. */
export function matchKnownItem(
  label: string,
  knownItems: readonly string[] = KNOWN_INV_ITEMS,
): string | undefined {
  const name = label.trim();
  if (!name || name.length < 2) return undefined;
  const nl = name.toLowerCase();
  for (const item of knownItems) {
    const kl = item.toLowerCase();
    if (nl === kl) return item;
    if (kl.length <= 3) continue; // avoid Cod ⊂ Code
    if (nl.includes(kl)) return item;
  }
  return undefined;
}

/** Infer item name from an image URL path segment. */
export function itemNameFromImageSrc(src: string): string | undefined {
  const filename = src.split('/').pop()?.replace(/\.\w+$/i, '').toLowerCase() ?? '';
  if (!filename) return undefined;
  if (ITEM_SLUG_MAP[filename]) return ITEM_SLUG_MAP[filename];
  for (const [slug, name] of Object.entries(ITEM_SLUG_MAP)) {
    if (slug.length <= 3) continue;
    if (filename.includes(slug)) return name;
  }
  if (filename === 'cod') return 'Cod';
  return undefined;
}

/** Regex parse of visible inventory text (`Item x 25`, line-ending counts). */
export function parseInventoryCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const patterns = [
    /([A-Za-z][A-Za-z' -]{1,40})\s+x\s*(\d+(?:[.,]\d+)?[kK]?)/g,
    /(\d+(?:[.,]\d+)?[kK]?)\s*x\s+([A-Za-z][A-Za-z' -]{1,40})/gi,
    /([A-Za-z][A-Za-z' -]{1,40})\s+(\d+(?:[.,]\d+)?[kK]?)\s*$/gm,
    /([A-Za-z][A-Za-z' -]{1,40})\s*[\n\r]+\s*(\d+(?:[.,]\d+)?[kK]?)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      let name: string;
      let qtyRaw: string;
      if (/^\d/.test(match[1])) {
        qtyRaw = match[1];
        name = match[2].trim();
      } else {
        name = match[1].trim();
        qtyRaw = match[2];
      }
      const qty = parseQuantityString(qtyRaw);
      const matched = matchKnownItem(name);
      if (!matched || !qty) continue;
      counts[matched] = Math.max(counts[matched] ?? 0, qty);
    }
  }
  return counts;
}

/** Extract known item quantities from detail panels / modals / tooltip text. */
export function extractItemQuantitiesFromText(
  text: string,
  knownItems: readonly string[] = KNOWN_INV_ITEMS,
): Record<string, number> {
  const counts = { ...parseInventoryCounts(text) };
  for (const name of knownItems) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = `(?:^|[^A-Za-z])${escaped}(?:[^A-Za-z]|$)`;
    if (!new RegExp(boundary, 'i').test(text)) continue;

    const patterns = [
      new RegExp(`${escaped}[^0-9]{0,40}([0-9]+(?:[.,][0-9]+)?[kK]?)`, 'i'),
      new RegExp(`([0-9]+(?:[.,][0-9]+)?[kK]?)\\s*x\\s*${escaped}`, 'i'),
      new RegExp(`${escaped}\\s*[\\n\\r]+\\s*([0-9]+(?:[.,][0-9]+)?[kK]?)`, 'i'),
      new RegExp(
        `${escaped}[\\s\\S]{0,80}?(?:Quantity|Qty|Amount|Stack)\\s*[:\\s]+\\s*([0-9]+(?:[.,][0-9]+)?[kK]?)`,
        'i',
      ),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (!m?.[1]) continue;
      const qty = parseQuantityString(m[1]);
      if (qty > 0) counts[name] = Math.max(counts[name] ?? 0, qty);
    }
    if (!(name in counts)) counts[name] = Math.max(counts[name] ?? 0, 1);
  }
  return counts;
}

/** Drop page-chrome false positives (e.g. Code of Conduct → Cod). */
export function sanitizeInventoryCounts(raw: Record<string, number>): Record<string, number> {
  const inventory: Record<string, number> = {};
  for (const [key, qty] of Object.entries(raw)) {
    if (/^cod$/i.test(key) && !/raw\s*cod|cooked\s*cod|burnt\s*cod/i.test(key) && qty >= 200) {
      continue;
    }
    if (CHROME_ITEM_DENY.test(key)) continue;
    const matched = matchKnownItem(key) ?? key;
    if (CHROME_ITEM_DENY.test(matched)) continue;
    inventory[matched] = Math.max(inventory[matched] ?? 0, qty);
  }
  return inventory;
}

export function detectHasBait(
  inventory: Record<string, number>,
  inventoryText: string,
): boolean {
  return (
    (inventory['Cheap Bait'] ?? 0) > 0 ||
    /Cheap\s*Bait/i.test(inventoryText) ||
    /\b(?:cheap\s+)?bait\b/i.test(inventoryText) ||
    Object.keys(inventory).some((k) => /cheap\s*bait|^bait$/i.test(k))
  );
}

function mergeCounts(
  target: Record<string, number>,
  patch: Record<string, number>,
): Record<string, number> {
  for (const [key, qty] of Object.entries(patch)) {
    if (!qty || qty <= 0) continue;
    target[key] = Math.max(target[key] ?? 0, qty);
  }
  return target;
}

/** Browser-side pass: aria/title/alt, image slugs, and badge text near icons. */
export const INVENTORY_DOM_STATIC_SCRIPT = String.raw`([known, slugMap]) => {
  const out = {};
  const bump = (name, qty) => {
    if (!name || !Number.isFinite(qty) || qty <= 0) return;
    out[name] = Math.max(out[name] || 0, qty);
  };
  const parseQty = (raw) => {
    if (!raw) return 0;
    const t = String(raw).trim().replace(/,/g, '');
    const mk = t.match(/^(\d+(?:\.\d+)?)[kK]$/);
    if (mk) return Math.round(Number.parseFloat(mk[1]) * 1000);
    const m = t.match(/^(\d+)$/);
    return m ? Number.parseInt(m[1], 10) : 0;
  };
  const matchKnown = (label) => {
    const name = String(label || '').trim();
    if (!name || name.length < 2) return null;
    const nl = name.toLowerCase();
    for (const k of known) {
      const kl = String(k).toLowerCase();
      if (nl === kl) return k;
      if (kl.length <= 3) continue;
      if (nl.includes(kl)) return k;
    }
    return null;
  };
  const itemFromSrc = (src) => {
    const filename = String(src || '').split('/').pop().replace(/\.\w+$/i, '').toLowerCase();
    if (!filename) return null;
    if (slugMap[filename]) return slugMap[filename];
    for (const [slug, name] of Object.entries(slugMap)) {
      if (slug.length <= 3) continue;
      if (filename.includes(slug)) return name;
    }
    if (filename === 'cod') return 'Cod';
    return null;
  };
  const qtyNear = (el) => {
    const root = el.closest('button, [role="button"], a, li, div') || el.parentElement;
    const text = (root && root.textContent ? root.textContent : '').replace(/\s+/g, ' ');
    const m = text.match(/(\d+(?:\.\d+)?[kK]?)/);
    return parseQty(m && m[1]) || 0;
  };

  const attrNodes = Array.from(
    document.querySelectorAll(
      '[title], img[alt], [aria-label], [data-tooltip], [data-tip], [data-original-title]',
    ),
  );
  for (const el of attrNodes) {
    const label =
      el.getAttribute('title') ||
      el.getAttribute('data-tooltip') ||
      el.getAttribute('data-tip') ||
      el.getAttribute('data-original-title') ||
      el.getAttribute('alt') ||
      el.getAttribute('aria-label') ||
      '';
    const matched = matchKnown(label);
    if (matched) bump(matched, qtyNear(el) || 1);
    if (el.tagName === 'IMG') {
      const fromImg = itemFromSrc(el.getAttribute('src') || '');
      if (fromImg) bump(fromImg, qtyNear(el) || 1);
    }
  }

  const slotButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
  for (const btn of slotButtons) {
    const label = (btn.textContent || '').trim().replace(/\s+/g, ' ');
    if (/^empty$/i.test(label)) continue;
    if (/sort|filter|sell|vendor|bank|market|quest|profile|combat/i.test(label)) continue;
    const img = btn.querySelector('img');
    const aria = btn.getAttribute('aria-label') || '';
    const title = btn.getAttribute('title') || '';
    const fromImg = img ? itemFromSrc(img.getAttribute('src') || '') : null;
    const fromLabel = matchKnown(label) || matchKnown(aria) || matchKnown(title);
    const matched = fromLabel || fromImg;
    if (!matched) continue;
    const qtyMatch = label.match(/^(\d+(?:\.\d+)?[kK]?)$/);
    const qty = qtyMatch ? parseQty(qtyMatch[1]) : qtyNear(btn);
    bump(matched, qty || 1);
  }

  const tippy = document.querySelector('.tippy-content');
  if (tippy) {
    const tip = (tippy.textContent || '').trim();
    const matched = matchKnown(tip);
    if (matched) bump(matched, parseQty(tip.match(/(\d+(?:\.\d+)?[kK]?)/)?.[1]) || 1);
  }

  return out;
}`;

async function scrapeStaticDom(page: Page): Promise<Record<string, number>> {
  try {
    return (await page.evaluate(INVENTORY_DOM_STATIC_SCRIPT, [
      KNOWN_INV_ITEMS,
      ITEM_SLUG_MAP,
    ] as [string[], Record<string, string>])) as Record<string, number>;
  } catch {
    return {};
  }
}

function looksLikeInventorySlot(label: string, aria: string, title: string): boolean {
  const combined = `${label} ${aria} ${title}`.trim();
  if (!combined) return true; // icon-only
  if (SLOT_SKIP_LABEL.test(label)) return false;
  if (/sort|filter|sell|vendor|bank|market|quest|profile|combat/i.test(combined)) return false;
  if (/^(\d+(?:\.\d+)?[kK]?)$/.test(label)) return true;
  if (KNOWN_INV_ITEMS.some((k) => combined.includes(k))) return true;
  if (/bait|cod|coal|log|ore|salmon|tuna/i.test(combined)) return true;
  return label.length <= 12;
}

async function scrapeFromTooltips(page: Page, counts: Record<string, number>): Promise<void> {
  const slots = page.locator('button:has(img), [role="button"]:has(img)');
  const total = Math.min(await slots.count(), 72);
  for (let i = 0; i < total; i++) {
    const slot = slots.nth(i);
    const label = (await slot.innerText().catch(() => '')).trim();
    const aria = (await slot.getAttribute('aria-label').catch(() => '')) ?? '';
    const title = (await slot.getAttribute('title').catch(() => '')) ?? '';
    if (/^Empty$/i.test(label)) continue;
    if (!looksLikeInventorySlot(label, aria, title)) continue;

    await slot.hover({ timeout: 1200 }).catch(() => undefined);
    await page.waitForTimeout(140);

    const tooltip = page.locator('.tippy-content:visible, [role="tooltip"]:visible').first();
    if ((await tooltip.count()) === 0) continue;
    const tipText = (await tooltip.innerText().catch(() => '')).trim();
    const matched = matchKnownItem(tipText);
    if (!matched) continue;

    const qtyFromTip = parseQuantityString(tipText.match(/(\d+(?:\.\d+)?[kK]?)/)?.[1]);
    const qtyFromLabel = parseQuantityString(label);
    counts[matched] = Math.max(counts[matched] ?? 0, qtyFromTip || qtyFromLabel || 1);
  }
}

async function readDetailPanelText(page: Page): Promise<string> {
  const regions = [
    page.locator('[role="dialog"]'),
    page.locator('[x-data]').filter({ hasText: /Quantity|Qty|Sell to Vendor/i }),
    page.locator('main'),
    page.locator('body'),
  ];
  for (const region of regions) {
    if ((await region.count()) === 0) continue;
    const text = await region.first().innerText().catch(() => '');
    if (text && /Oak Log|Coal Ore|Cheap Bait|Cod|Cooked Cod|Sell to Vendor/i.test(text)) {
      return text;
    }
  }
  return page.locator('body').innerText();
}

async function scrapeFromSlotClicks(page: Page, counts: Record<string, number>): Promise<void> {
  const buttons = page.getByRole('button');
  const total = await buttons.count();
  let inspected = 0;
  for (let i = 0; i < total && inspected < 60; i++) {
    const btn = buttons.nth(i);
    const label = (await btn.innerText().catch(() => '')).trim();
    const aria = (await btn.getAttribute('aria-label').catch(() => '')) ?? '';
    const title = (await btn.getAttribute('title').catch(() => '')) ?? '';
    if (/^Empty$/i.test(label)) continue;
    if (!looksLikeInventorySlot(label, aria, title)) continue;

    await btn.click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(220);
    const panelText = await readDetailPanelText(page);
    mergeCounts(counts, extractItemQuantitiesFromText(panelText));
    inspected += 1;
  }
}

/** Icon-heavy inventory: scrape attrs, image slugs, tooltips, and click-through detail panels. */
export async function scrapeInventoryFromDom(page: Page): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  mergeCounts(counts, await scrapeStaticDom(page));
  await scrapeFromTooltips(page, counts).catch(() => undefined);
  await scrapeFromSlotClicks(page, counts).catch(() => undefined);
  return counts;
}

/** Merge text + DOM scrapes and drop false positives. */
export function buildInventoryMap(
  inventoryText: string,
  domCounts: Record<string, number>,
): Record<string, number> {
  return sanitizeInventoryCounts({
    ...parseInventoryCounts(inventoryText),
    ...extractItemQuantitiesFromText(inventoryText),
    ...domCounts,
  });
}
