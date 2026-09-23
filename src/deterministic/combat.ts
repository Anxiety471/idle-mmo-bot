import type { Locator, Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { BattleState, CombatStepResult, EnemyInfo, HuntState, Stance } from '../types.js';
import { navigateTo } from '../browser.js';
import { decodeIdleMmoMetaSlug } from '../snapshot/inventory-scrape.js';

/**
 * Deterministic combat click-path helpers.
 *
 * Selectors follow live-tested flows on /combat/battle.
 * UI may change — update selectors when automation breaks.
 * Never invent battle outcomes; only drive clicks and read visible state.
 *
 * Post-hunt sessions may show Hunt More / ENEMIES NEARBY without Start Hunt.
 */

const COMBAT_PATH = '/combat/battle';
/** Max wait for async combat controls after domcontentloaded (~3–4s observed). */
const COMBAT_UI_SETTLE_MS = 10_000;

/** Legacy playbook selector; UI may use other Tailwind height classes now. */
const ENEMY_CARD_HEIGHT_CLASSES = ['h-24', 'h-20', 'h-28', 'h-32'];

const ACTION_BUTTON_PATTERN =
  /^(Start Hunt|Stop|Cancel Hunt|Battle|Run Away|Hunt More|Close|Start anyway|Create|Invites|Talk|Overview|Turn In)$/i;

/** Live UI may label the hunt-stop control "Stop" or "Cancel Hunt". */
const HUNT_STOP_BUTTON_NAMES = ['Stop', 'Cancel Hunt'];

/** Nav/chrome labels that are not enemy cards. */
const NAV_CHROME_PATTERN =
  /^(Windy|Search|Map|Party|Skills|Combat|Inventory|Quests|Merchants|Profile|Character|Settings|Menu|Playing|Equipment|Bank|Market|Woodcutting|Mining|Fishing|Alchemy|Smelting|Cooking|Forge|Construction|Meditation|show-map)$/i;

const PURE_NUMERIC_PATTERN = /^\d+$/;
const PLAYER_PROFILE_PATTERN = /\bTotal\s*Lv\.?\s*\d+/i;
const ENEMIES_NEARBY_LABEL_PATTERN = /^ENEMIES\s+NEARBY/i;
const CURRENT_ACTION_MARKER = 'CURRENT ACTION';
/** Live mobile Battle UI uses "Hunting" header (not always "CURRENT ACTION"). */
const HUNTING_PANEL_MARKERS = ['Hunting', CURRENT_ACTION_MARKER];
const HUNT_METRICS_END_MARKERS = ['ENEMIES NEARBY', 'Power Hunt', 'Character', 'Skills', 'Pets', 'Menu'];
const ENEMY_TILE_SKIP_PATTERN =
  /^(Power Hunt|Hunt More|Stop|Cancel Hunt|Battle|Stats|Back|Menu|Character|Skills|Pets)$/i;

/** Map CDN/meta image slugs to enemy display names (icon-only tiles). */
const ENEMY_SLUG_MAP: Record<string, string> = {
  rabbit: 'Rabbit',
  goblin: 'Goblin',
  duck: 'Duck',
  'crown-goblin': 'Crown Goblin',
  crown_goblin: 'Crown Goblin',
  crown: 'Crown Goblin',
};

async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

async function safeInnerText(locator: Locator, timeoutMs = 3000): Promise<string> {
  try {
    return (await locator.innerText({ timeout: timeoutMs })).trim();
  } catch {
    return '';
  }
}

async function isButtonVisible(page: Page, name: string): Promise<boolean> {
  const btn = page.getByRole('button', { name, exact: true });
  if (await btn.count() === 0) return false;
  return btn.first().isVisible();
}

async function isHuntStopVisible(page: Page): Promise<boolean> {
  for (const name of HUNT_STOP_BUTTON_NAMES) {
    if (await isButtonVisible(page, name)) return true;
  }
  return false;
}

async function clickHuntStopButton(page: Page): Promise<boolean> {
  for (const name of HUNT_STOP_BUTTON_NAMES) {
    const btn = page.getByRole('button', { name, exact: true });
    if (await btn.count() === 0) continue;
    await btn.first().click();
    return true;
  }
  return false;
}

/** Prefer Hunting / Battle panel text over full body to reduce nav noise. */
async function readCombatPanelText(page: Page): Promise<string> {
  for (const marker of HUNTING_PANEL_MARKERS) {
    const heading = page.getByText(marker, { exact: true }).first();
    if (await heading.count() === 0) continue;
    const container = heading.locator(
      'xpath=ancestor::*[self::section or self::div][position()<=5]',
    );
    if (await container.count() > 0) {
      const text = await safeInnerText(container.first());
      if (text.includes('Total Enemies Found') || text.includes('Enemies Remaining')) {
        return text;
      }
    }
  }

  const main = page.locator('main');
  if (await main.count() > 0) {
    const text = await safeInnerText(main.first());
    if (text) return text;
  }

  return pageText(page);
}

/** Wait for any primary combat control after navigation. */
async function waitForCombatUiSettled(page: Page, timeoutMs = COMBAT_UI_SETTLE_MS): Promise<void> {
  const controls = page
    .getByRole('button', { name: 'Start Hunt', exact: true })
    .or(page.getByRole('button', { name: 'Hunt More', exact: true }))
    .or(page.getByRole('button', { name: 'Stop', exact: true }))
    .or(page.getByRole('button', { name: 'Cancel Hunt', exact: true }))
    .or(page.getByRole('button', { name: 'Battle', exact: true }));

  await controls
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {
      // Best-effort: page may already show enemy cards without these buttons visible yet.
    });
}

/** Handle "Start a new action?" after Start Hunt or Hunt More. */
async function handleReplaceDialog(
  page: Page,
  allowInterrupt: boolean,
): Promise<'continued' | 'no_action' | 'failed'> {
  const dialog = page.getByText('Start a new action?');
  if (!(await dialog.isVisible({ timeout: 2000 }).catch(() => false))) {
    return 'continued';
  }

  if (allowInterrupt) {
    const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
    if (await startAnyway.count() > 0) {
      await startAnyway.click();
      return 'continued';
    }
    return 'failed';
  }

  const closeButton = page.getByRole('button', { name: 'Close', exact: true });
  if (await closeButton.count() > 0) {
    await closeButton.click();
    return 'no_action';
  }

  return 'failed';
}

function isExcludedEnemyButton(text: string): boolean {
  const trimmed = text.trim();
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return true;
  if (PURE_NUMERIC_PATTERN.test(firstLine)) return true;
  if (ACTION_BUTTON_PATTERN.test(firstLine)) return true;
  if (NAV_CHROME_PATTERN.test(firstLine)) return true;
  if (ENEMIES_NEARBY_LABEL_PATTERN.test(firstLine)) return true;
  if (PLAYER_PROFILE_PATTERN.test(trimmed)) return true;
  if (/^[\d,.\s]+$/.test(firstLine)) return true;
  return false;
}

/** Extract creature name from a card; null when chrome/profile/count badge. */
function extractEnemyName(text: string): string | null {
  if (isExcludedEnemyButton(text)) return null;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (PURE_NUMERIC_PATTERN.test(line)) continue;
    if (/^Lv\.?\s*\d+/i.test(line)) continue;
    if (ENEMIES_NEARBY_LABEL_PATTERN.test(line)) continue;
    if (ACTION_BUTTON_PATTERN.test(line)) continue;
    if (NAV_CHROME_PATTERN.test(line)) continue;
    if (PLAYER_PROFILE_PATTERN.test(line)) continue;
    return line;
  }

  return null;
}

/** Dedicated locator for the ENEMIES NEARBY sidebar widget (not main content). */
async function getEnemiesNearbyWidget(page: Page): Promise<Locator | null> {
  const heading = page.getByText(ENEMIES_NEARBY_LABEL_PATTERN).first();
  if (await heading.count() === 0 || !(await heading.isVisible().catch(() => false))) {
    return null;
  }

  const containers = page.locator('section, div, article').filter({
    has: page.getByText(ENEMIES_NEARBY_LABEL_PATTERN),
  });

  const count = await containers.count();
  let best: Locator | null = null;
  let bestArea = Infinity;

  for (let i = 0; i < count; i++) {
    const container = containers.nth(i);
    if (!(await container.isVisible().catch(() => false))) continue;

    const tagName = await container.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    if (tagName === 'main' || tagName === 'body') continue;

    const buttons = container.getByRole('button');
    const btnCount = await buttons.count();
    let hasNumericBadge = false;
    for (let j = 0; j < btnCount; j++) {
      const btn = buttons.nth(j);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const text = await safeInnerText(btn);
      if (PURE_NUMERIC_PATTERN.test(text)) {
        hasNumericBadge = true;
        break;
      }
    }
    if (!hasNumericBadge) continue;

    const box = await container.boundingBox();
    if (!box) continue;
    const area = box.width * box.height;
    if (area < bestArea) {
      bestArea = area;
      best = container;
    }
  }

  if (best) return best;

  const fallback = heading.locator('xpath=./parent::div | ./parent::section');
  if (await fallback.count() > 0) {
    const tag = await fallback.first().evaluate((el) => el.tagName.toLowerCase()).catch(() => 'main');
    if (tag !== 'main' && tag !== 'body') return fallback.first();
  }

  return null;
}

/** Prefer the ENEMIES NEARBY panel; fall back to main content. */
async function getEnemySearchRoot(page: Page): Promise<Locator> {
  const label = page.getByText(/ENEMIES\s+NEARBY/i).first();
  if (await label.count() > 0 && await label.isVisible().catch(() => false)) {
    const containers = page.locator('section, div, article').filter({
      has: page.getByText(/ENEMIES\s+NEARBY/i),
    });
    const count = await containers.count();
    for (let i = count - 1; i >= 0; i--) {
      const container = containers.nth(i);
      const cardCount = await container.locator('button.h-24, button.h-20, button.h-28').count();
      if (cardCount > 0) return container;
    }

    const widget = await getEnemiesNearbyWidget(page);
    if (widget) return widget;

    if (count > 0) return containers.last();
  }

  const main = page.locator('main');
  if (await main.count() > 0) return main.first();
  return page.locator('body');
}

async function filterVisibleEnemyButtons(locator: Locator): Promise<Locator[]> {
  const count = await locator.count();
  const visible: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const btn = locator.nth(i);
    if (!(await btn.isVisible())) continue;
    const text = await safeInnerText(btn);
    if (isExcludedEnemyButton(text)) continue;
    if (!extractEnemyName(text)) continue;
    visible.push(btn);
  }
  return visible;
}

async function collectCardsInScope(scope: Locator): Promise<Locator[]> {
  for (const cls of ENEMY_CARD_HEIGHT_CLASSES) {
    const cards = scope.locator(`button.${cls}`);
    const visible = await filterVisibleEnemyButtons(cards);
    if (visible.length > 0) return visible;
  }

  const withLevel = scope.getByRole('button').filter({ hasText: /\bLv\.?\s*\d+/i });
  const levelVisible = await filterVisibleEnemyButtons(withLevel);
  if (levelVisible.length > 0) return levelVisible;

  const buttons = scope.getByRole('button');
  const count = await buttons.count();
  const heuristic: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible())) continue;
    const text = await safeInnerText(btn);
    if (isExcludedEnemyButton(text)) continue;
    const name = extractEnemyName(text);
    if (!name) continue;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2 && !/\bLv\.?\s*\d+/i.test(text)) continue;
    heuristic.push(btn);
  }
  return heuristic;
}

/** Collect visible enemy card buttons; scoped to ENEMIES NEARBY when present. */
async function collectEnemyCardButtons(page: Page): Promise<Locator[]> {
  const root = await getEnemySearchRoot(page);
  const scoped = await collectCardsInScope(root);
  if (scoped.length > 0) return scoped;

  const main = page.locator('main');
  if (await main.count() > 0) {
    const fromMain = await collectCardsInScope(main.first());
    if (fromMain.length > 0) return fromMain;
  }

  return [];
}

/** Post-Stop ENEMIES NEARBY icon tiles (image + quantity badge, no text names). */
async function collectEnemyIconTiles(page: Page): Promise<Locator[]> {
  const widget = await getEnemiesNearbyWidget(page);
  if (!widget) return [];

  const buttons = widget.getByRole('button');
  const count = await buttons.count();
  const tiles: Locator[] = [];

  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    if ((await btn.locator('img').count()) === 0) continue;

    const text = await safeInnerText(btn);
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    if (ENEMY_TILE_SKIP_PATTERN.test(firstLine)) continue;
    if (ACTION_BUTTON_PATTERN.test(firstLine)) continue;

    tiles.push(btn);
  }

  return tiles;
}

export function enemyNameFromImageSrc(src: string): string | undefined {
  const decoded = decodeIdleMmoMetaSlug(src);
  const rawSlug = (decoded ?? src.split('/').pop()?.replace(/\..*$/, '') ?? '').toLowerCase();
  const normalized = rawSlug.replace(/[_\s]+/g, '-');
  const slugs = Object.entries(ENEMY_SLUG_MAP).sort(([a], [b]) => b.length - a.length);
  for (const [slug, name] of slugs) {
    if (normalized.includes(slug) || rawSlug.includes(slug.replace(/-/g, ''))) {
      return name;
    }
  }
  return undefined;
}

async function enemyNameFromTile(btn: Locator): Promise<string> {
  const img = btn.locator('img').first();
  if (await img.count() > 0) {
    const alt = (await img.getAttribute('alt'))?.trim();
    if (alt && !PURE_NUMERIC_PATTERN.test(alt)) return alt;
    const src = await img.getAttribute('src');
    if (src) {
      const fromSrc = enemyNameFromImageSrc(src);
      if (fromSrc) return fromSrc;
    }
  }
  const aria = (await btn.getAttribute('aria-label'))?.trim();
  if (aria) return aria;
  const title = (await btn.getAttribute('title'))?.trim();
  if (title) return title;
  return 'Enemy';
}

async function enemyInfosFromButtons(buttons: Locator[]): Promise<EnemyInfo[]> {
  const enemies: EnemyInfo[] = [];
  for (let i = 0; i < buttons.length; i++) {
    const text = await safeInnerText(buttons[i]);
    const name = extractEnemyName(text);
    if (!name) continue;
    enemies.push({ name, index: enemies.length });
  }
  return enemies;
}

/** Text cards or icon tiles from ENEMIES NEARBY (mixed enemy types). */
async function collectEnemyTiles(page: Page): Promise<{ buttons: Locator[]; enemies: EnemyInfo[] }> {
  const textCards = await collectEnemyCardButtons(page);
  const textEnemies = await enemyInfosFromButtons(textCards);
  if (textEnemies.length > 0) {
    return { buttons: textCards, enemies: textEnemies };
  }

  const iconTiles = await collectEnemyIconTiles(page);
  const enemies: EnemyInfo[] = [];
  for (let i = 0; i < iconTiles.length; i++) {
    enemies.push({ name: await enemyNameFromTile(iconTiles[i]), index: i });
  }
  return { buttons: iconTiles, enemies };
}

/**
 * Pick a battle target from a mixed ENEMIES NEARBY list.
 * Prefer Rabbit when present; otherwise first ready enemy — never block on rabbit-only.
 */
export function pickBattleEnemy(enemies: EnemyInfo[]): EnemyInfo | undefined {
  if (enemies.length === 0) return undefined;
  const rabbit = enemies.find((e) => /\brabbit\b/i.test(e.name));
  return rabbit ?? enemies[0];
}

async function isEnemyDetailPanelOpen(page: Page): Promise<boolean> {
  const hasStance = await page
    .getByText(/^STANCE$/i)
    .first()
    .isVisible()
    .catch(() => false);
  const hasBattle = await page
    .getByRole('button', { name: 'Battle', exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  return hasStance && hasBattle;
}

/** Numeric count button in ENEMIES NEARBY (e.g. "40") — opens enemy detail panel. */
async function findEnemiesNearbyCountButton(page: Page): Promise<Locator | null> {
  const widget = await getEnemiesNearbyWidget(page);
  if (!widget) return null;

  const buttons = widget.getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible())) continue;
    const text = await safeInnerText(btn);
    if (PURE_NUMERIC_PATTERN.test(text)) return btn;
  }
  return null;
}

async function dismissBlockingOverlays(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);

  const overlays = page.locator('div.absolute.inset-0.bg-immo');
  const overlayCount = await overlays.count();
  for (let i = 0; i < overlayCount; i++) {
    await overlays.nth(i).waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined);
  }

  const closeBtn = page.getByRole('button', { name: 'Close', exact: true });
  const closeCount = await closeBtn.count();
  for (let i = 0; i < closeCount; i++) {
    const btn = closeBtn.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => undefined);
    }
  }
}

/** Read enemy name from open detail panel (e.g. Rabbit). */
async function readEnemyNameFromDetailPanel(page: Page): Promise<string | null> {
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.count() > 0) {
    const heading = dialog.locator('h1, h2, h3').first();
    if (await heading.count() > 0) {
      const name = await safeInnerText(heading);
      if (name && !/^(STANCE|LOOT|FOOD|ENEMIES)$/i.test(name)) return name;
    }
  }

  const text = await pageText(page);
  const match = text.match(/\n([A-Za-z][A-Za-z' -]+)\s*\n\s*\d+\s+Combat EXP/i);
  return match?.[1]?.trim() ?? null;
}

/** Match stance option labels like "Balanced (All Stats)" from short name "Balanced". */
function stanceOptionMatches(label: string, stance: Stance): boolean {
  const normalized = label.trim().toLowerCase();
  const needle = stance.toLowerCase();
  return normalized.startsWith(needle) || normalized.includes(`(${needle}`) || normalized.includes(needle);
}

async function selectStanceFromNativeSelect(select: Locator, stance: Stance): Promise<boolean> {
  const options = select.locator('option');
  const count = await options.count();

  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const label = ((await opt.textContent()) ?? '').trim();
    if (!label || !stanceOptionMatches(label, stance)) continue;

    const value = await opt.getAttribute('value');
    try {
      if (value !== null && value !== '') {
        await select.selectOption(value, { timeout: 3000 });
      } else {
        await select.selectOption({ label }, { timeout: 3000 });
      }
      return true;
    } catch {
      try {
        await select.selectOption({ label }, { timeout: 3000 });
        return true;
      } catch {
        // try next matching option
      }
    }
  }

  // Fallback: keep default / first non-empty option rather than abort Battle.
  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const label = ((await opt.textContent()) ?? '').trim();
    if (!label) continue;
    const value = await opt.getAttribute('value');
    try {
      if (value !== null && value !== '') {
        await select.selectOption(value, { timeout: 3000 });
      } else {
        await select.selectOption({ label }, { timeout: 3000 });
      }
      return true;
    } catch {
      // leave default
    }
  }

  return false;
}

async function setStance(page: Page, stance: Stance): Promise<void> {
  try {
    const namedSelect = page.locator('select[name="location"]');
    if (await namedSelect.count() > 0) {
      await selectStanceFromNativeSelect(namedSelect.first(), stance);
      return;
    }

    const stanceSelect = page.locator('select').filter({
      hasText: /Balanced|Offensive|Defensive|Agile|Dexterous/i,
    });
    if (await stanceSelect.count() > 0) {
      await selectStanceFromNativeSelect(stanceSelect.first(), stance);
      return;
    }

    const combobox = page.getByRole('combobox').filter({
      hasText: /Balanced|Offensive|Defensive|Agile|Dexterous/i,
    });
    if (await combobox.count() > 0) {
      await combobox.first().click({ timeout: 3000 }).catch(() => undefined);
      const option = page.getByRole('option', { name: new RegExp(`^${stance}`, 'i') });
      if (await option.count() > 0) {
        await option.first().click({ timeout: 3000 }).catch(() => undefined);
      }
    }
  } catch {
    // Stance is best-effort — proceed with UI default and still click Battle.
  }
}

async function setMaxEnemies(page: Page, maxEnemies: number): Promise<void> {
  let maxInput = page.locator('input#max_enemies');
  if (await maxInput.count() === 0) {
    maxInput = page.locator('input[type="number"]');
  }
  if (await maxInput.count() > 0) {
    await maxInput.first().fill(String(maxEnemies));
  }
}

/**
 * Click the ENEMIES NEARBY count button to open the enemy detail panel.
 * Post-Stop UI shows a numeric badge (e.g. 40), not creature card buttons.
 */
export async function openEnemiesNearbyPanel(page: Page): Promise<CombatStepResult> {
  try {
    if (await isEnemyDetailPanelOpen(page)) {
      return 'enemy_selected';
    }

    const { buttons, enemies } = await collectEnemyTiles(page);
    const picked = pickBattleEnemy(enemies);
    const targetBtn = picked ? buttons[picked.index] : await findEnemiesNearbyCountButton(page);
    if (!targetBtn) {
      return 'failed';
    }

    await dismissBlockingOverlays(page);
    await targetBtn.click({ force: true, timeout: 5000 }).catch(() => undefined);
    await page
      .getByText(/^STANCE$/i)
      .first()
      .waitFor({ state: 'visible', timeout: COMBAT_UI_SETTLE_MS })
      .catch(() => undefined);

    if (await isEnemyDetailPanelOpen(page)) {
      return 'enemy_selected';
    }

    return 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Post-Stop enemy selection is ready (detail panel, count badge, or creature cards).
 * Does NOT match the ENEMIES NEARBY sidebar label alone — that label stays visible
 * during active hunts (Stop button) and caused false positives + hunt_metrics_pending loops.
 */
export async function hasEnemySelectionReady(page: Page): Promise<boolean> {
  if (await isEnemyDetailPanelOpen(page)) return true;
  const { enemies } = await collectEnemyTiles(page);
  return enemies.length > 0;
}

/**
 * Post-Stop enemy selection only. The ENEMIES NEARBY count badge (zone pool, e.g. 40)
 * stays visible during active hunts — must not bypass metrics wait.
 */
export async function hasPostHuntEnemySelectionReady(page: Page): Promise<boolean> {
  if (await isHuntStopVisible(page)) return false;
  return hasEnemySelectionReady(page);
}

/**
 * Ensure combat is in a hunt-ready state. Handles fresh Start Hunt, post-hunt Hunt More,
 * active hunts (Stop visible), and leftover enemy-select screens.
 */
export async function ensureHuntActive(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  await navigateTo(page, config, COMBAT_PATH);
  await waitForCombatUiSettled(page);

  if (await isButtonVisible(page, 'Start Hunt')) {
    await page.getByRole('button', { name: 'Start Hunt', exact: true }).first().click();
    const dialog = await handleReplaceDialog(page, allowInterrupt);
    if (dialog === 'no_action') return 'no_action';
    if (dialog === 'failed') return 'failed';
    return 'hunt_started';
  }

  if (await isButtonVisible(page, 'Hunt More')) {
    await page.getByRole('button', { name: 'Hunt More', exact: true }).first().click();
    const dialog = await handleReplaceDialog(page, allowInterrupt);
    if (dialog === 'no_action') return 'no_action';
    if (dialog === 'failed') return 'failed';
    return 'hunt_started';
  }

  if (await isHuntStopVisible(page)) {
    return 'hunt_already_active';
  }

  if (await hasEnemySelectionReady(page)) {
    return 'enemy_select_ready';
  }

  return 'failed';
}

/** @deprecated Use ensureHuntActive — kept for compatibility. */
export async function startHunt(
  page: Page,
  config: AppConfig,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  return ensureHuntActive(page, config, allowInterrupt);
}

/** Whether hunt metrics or enemy cards indicate progress (pure helper for tests). */
export function hasHuntProgress(state: HuntState): boolean {
  return (
    (state.totalEnemiesFound ?? 0) > 0 ||
    state.enemies.length > 0 ||
    state.defeatedCount > 0
  );
}

/** Slice active Hunting panel; excludes ENEMIES NEARBY post-stop grid counts. */
export function huntingMetricsSection(pageText: string): string {
  for (const marker of HUNTING_PANEL_MARKERS) {
    if (!pageText.includes(marker)) continue;
    const start = pageText.indexOf(marker);
    let end = start + 1200;
    for (const endMarker of HUNT_METRICS_END_MARKERS) {
      const idx = pageText.indexOf(endMarker, start + marker.length);
      if (idx > start) end = Math.min(end, idx);
    }
    return pageText.slice(start, end);
  }
  return '';
}

function parseMetricNearLabel(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inline = text.match(
      new RegExp(`${escaped}\\s*[:\\-]?\\s*(\\d+(?:\\.\\d+)?)`, 'i'),
    );
    if (inline?.[1]) return Number.parseInt(inline[1], 10);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const idx = lines.findIndex(
      (l) =>
        l.toLowerCase() === label.toLowerCase() ||
        l.toLowerCase().startsWith(`${label.toLowerCase()} `),
    );
    if (idx >= 0) {
      const sameLine = lines[idx].slice(label.length).match(/(\d+(?:\.\d+)?)/);
      if (sameLine?.[1]) return Number.parseInt(sameLine[1], 10);
      for (let j = idx + 1; j < Math.min(idx + 4, lines.length); j++) {
        const m = lines[j].match(/^(\d+(?:\.\d+)?)$/);
        if (m?.[1]) return Number.parseInt(m[1], 10);
      }
    }
  }
  return undefined;
}

export function parseHuntMetrics(text: string): {
  totalEnemiesFound?: number;
  enemiesRemaining?: number;
  bonusEnemies?: number;
} {
  const section = huntingMetricsSection(text);
  const sources = section ? [section, text] : [text];

  let totalEnemiesFound: number | undefined;
  let enemiesRemaining: number | undefined;
  let bonusEnemies: number | undefined;

  for (const source of sources) {
    totalEnemiesFound ??= parseMetricNearLabel(source, [
      'Total Enemies Found',
      'Enemies Found',
      'Enemies Hunted',
      'Hunted',
    ]);
    enemiesRemaining ??= parseMetricNearLabel(source, [
      'Enemies Remaining',
      'Remaining Enemies',
      'Remaining',
    ]);
    bonusEnemies ??= parseMetricNearLabel(source, ['Bonus Enemies', 'Bonus']);
  }

  return { totalEnemiesFound, enemiesRemaining, bonusEnemies };
}

/** DOM fallback when body.innerText ordering hides hunt metric values. */
async function scrapeHuntMetricsFromDom(page: Page): Promise<{
  totalEnemiesFound?: number;
  enemiesRemaining?: number;
  bonusEnemies?: number;
}> {
  async function readNear(labels: string[]): Promise<number | undefined> {
    for (const label of labels) {
      const exact = page.getByText(label, { exact: true }).first();
      const fuzzy = page.getByText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
      const labelEl = (await exact.count()) > 0 ? exact : fuzzy;
      if (await labelEl.count() === 0) continue;

      const line = await safeInnerText(labelEl);
      const inline = line.match(/:\s*(\d+(?:\.\d+)?)\s*$/);
      if (inline?.[1]) return Number.parseInt(inline[1], 10);

      // Live UI: label box left, value box right (sibling).
      const sibling = labelEl.locator('xpath=following-sibling::*[1]');
      if (await sibling.count() > 0) {
        const siblingText = await safeInnerText(sibling);
        const siblingNum = siblingText.match(/^(\d+(?:\.\d+)?)$/);
        if (siblingNum?.[1]) return Number.parseInt(siblingNum[1], 10);
      }

      const parent = labelEl.locator('xpath=parent::*');
      if (await parent.count() > 0) {
        const lastChild = parent.locator(':scope > *').last();
        if (await lastChild.count() > 0) {
          const lastText = await safeInnerText(lastChild);
          const lastNum = lastText.match(/^(\d+(?:\.\d+)?)$/);
          if (lastNum?.[1]) return Number.parseInt(lastNum[1], 10);
        }
      }

      for (let depth = 1; depth <= 4; depth++) {
        const container = labelEl.locator(
          `xpath=ancestor::*[self::div or self::section or self::article][${depth}]`,
        );
        if (await container.count() === 0) continue;
        const parsed = parseMetricNearLabel(await safeInnerText(container), [label]);
        if (parsed !== undefined) return parsed;
      }
    }
    return undefined;
  }

  const [totalEnemiesFound, enemiesRemaining, bonusEnemies] = await Promise.all([
    readNear(['Total Enemies Found', 'Enemies Found', 'Enemies Hunted', 'Hunted']),
    readNear(['Enemies Remaining', 'Remaining Enemies', 'Remaining']),
    readNear(['Bonus Enemies', 'Bonus']),
  ]);

  return { totalEnemiesFound, enemiesRemaining, bonusEnemies };
}

function mergeHuntMetrics(
  primary: ReturnType<typeof parseHuntMetrics>,
  fallback: ReturnType<typeof parseHuntMetrics>,
): ReturnType<typeof parseHuntMetrics> {
  return {
    totalEnemiesFound: primary.totalEnemiesFound ?? fallback.totalEnemiesFound,
    enemiesRemaining: primary.enemiesRemaining ?? fallback.enemiesRemaining,
    bonusEnemies: primary.bonusEnemies ?? fallback.bonusEnemies,
  };
}

/** Read hunt screen: metrics while hunting (Stop visible) and cards after Stop. */
export async function readHuntState(page: Page): Promise<HuntState> {
  const text = await pageText(page);
  const panelText = await readCombatPanelText(page);
  const { enemies } = await collectEnemyTiles(page);
  let metrics = mergeHuntMetrics(parseHuntMetrics(panelText), parseHuntMetrics(text));
  const domMetrics = await scrapeHuntMetricsFromDom(page).catch(() => ({}));
  metrics = mergeHuntMetrics(metrics, domMetrics);

  const defeatedMatch = text.match(/(\d+)\s+defeated/i);
  const defeatedCount = defeatedMatch ? Number.parseInt(defeatedMatch[1], 10) : 0;

  return {
    enemies,
    defeatedCount,
    ...metrics,
    pageText: text,
  };
}

/** Click Stop / Cancel Hunt on hunt screen and confirm. */
export async function stopHunt(page: Page): Promise<CombatStepResult> {
  if (!(await clickHuntStopButton(page))) {
    return 'no_action';
  }

  for (const name of HUNT_STOP_BUTTON_NAMES) {
    const confirmStop = page.getByRole('button', { name, exact: true });
    if (await confirmStop.count() > 1) {
      await confirmStop.last().click();
      break;
    }
  }

  return 'hunt_stopped';
}


/** Preferred cooked-food labels for pre-battle FOOD Add dialog. */
const BATTLE_FOOD_LABELS = [
  'Cooked Cod',
  'Cooked Salmon',
  'Cooked Tuna',
  'Cooked Trout',
  'Cooked Fish',
  'Bread',
];

/**
 * Idle MMO heals via food packed BEFORE Battle (effective HP), not mid-fight clicks.
 * Flow: FOOD → Add → food-for-battle modal → click Nx item → quantity modal → Max → Add.
 */
export async function selectBattleFood(page: Page): Promise<'added' | 'none' | 'failed'> {
  try {
    const foodHeading = page.getByText(/^FOOD$/i).first();
    if (!(await foodHeading.isVisible({ timeout: 2000 }).catch(() => false))) {
      return 'none';
    }

    const addNearFood = page
      .locator(
        'xpath=//*[normalize-space()="FOOD" or normalize-space()="Food"]/following::button[normalize-space()="Add"][1]',
      )
      .or(page.getByRole('button', { name: 'Add', exact: true }));

    if ((await addNearFood.count()) === 0) {
      console.log('[combat] FOOD Add not visible — no food UI');
      return 'none';
    }

    await addNearFood.first().click({ timeout: 5000 });
    await page.waitForTimeout(800);

    // food-for-battle modal: icon buttons show quantity as "25\\nx".
    const foodModal = page.locator('[x-data*="food-for-battle"]');
    const itemInModal = foodModal.locator('button').filter({ hasText: /\d+\s*x/i });
    const itemFallback = page.getByRole('button').filter({ hasText: /^\d+\s*x$/im });
    const foodItem = (await itemInModal.count()) > 0 ? itemInModal : itemFallback;

    if ((await foodItem.count()) === 0 || !(await foodItem.first().isVisible().catch(() => false))) {
      console.log('[combat] FOOD Add opened but no cooked food in inventory');
      await page.keyboard.press('Escape').catch(() => undefined);
      const closeFood = foodModal.locator('button').first();
      if ((await closeFood.count()) > 0) {
        await closeFood.click().catch(() => undefined);
      }
      return 'none';
    }

    await foodItem.first().click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(700);

    const body = await pageText(page);
    let foodName = 'food';
    const addItemMatch = body.match(/Add Item\s*\n\s*([^\n]+)/i);
    if (addItemMatch?.[1]) {
      foodName = addItemMatch[1].trim();
    } else {
      for (const label of BATTLE_FOOD_LABELS) {
        if (body.includes(label)) {
          foodName = label;
          break;
        }
      }
    }

    // Quantity modal (select-battle-food-quantity): input#quantity + Max + Add.
    const qtyModal = page.locator('[x-data*="select-battle-food-quantity"]');
    const qtyInput = page.locator('input#quantity, input[name="quantity"]');
    if ((await qtyInput.count()) > 0 && (await qtyInput.first().isVisible().catch(() => false))) {
      const maxNearQty = qtyModal
        .getByRole('button', { name: 'Max', exact: true })
        .or(
          page.locator(
            'xpath=//*[@id="quantity" or @name="quantity"]/following::button[normalize-space()="Max"][1]',
          ),
        );
      if ((await maxNearQty.count()) > 0) {
        await maxNearQty.first().click().catch(() => undefined);
      }
      await page.waitForTimeout(300);
    }

    const confirmAdd = qtyModal
      .getByRole('button', { name: 'Add', exact: true })
      .or(page.getByRole('button', { name: 'Add', exact: true }));

    // Prefer Add inside quantity modal; fall back to last visible Add.
    let confirmed = false;
    const modalAdd = qtyModal.getByRole('button', { name: 'Add', exact: true });
    if ((await modalAdd.count()) > 0 && (await modalAdd.first().isVisible().catch(() => false))) {
      await modalAdd.first().click({ timeout: 5000 });
      confirmed = true;
    } else if ((await confirmAdd.count()) > 0) {
      await confirmAdd.last().click({ timeout: 5000 }).catch(() => undefined);
      confirmed = true;
    }

    if (confirmed) {
      console.log(`[combat] Packed battle food: ${foodName}`);
      await page.waitForTimeout(500);
      return 'added';
    }

    console.log('[combat] FOOD quantity dialog missing Add confirm');
    await page.keyboard.press('Escape').catch(() => undefined);
    return 'failed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[combat] selectBattleFood failed: ${message}`);
    return 'failed';
  }
}

/**
 * Open enemy detail (if needed), set stance/max, click Battle.
 * Post-Stop: count button → detail panel. Legacy: click creature card first.
 */
export async function configureAndBattle(
  page: Page,
  enemyIndex: number,
  maxEnemies: number,
  stance: Stance,
): Promise<CombatStepResult> {
  if (!(await isEnemyDetailPanelOpen(page))) {
    const opened = await openEnemiesNearbyPanel(page);
    if (opened !== 'enemy_selected') {
      const { buttons, enemies } = await collectEnemyTiles(page);
      const picked = pickBattleEnemy(enemies);
      const targetIndex = picked?.index ?? enemyIndex;
      if (buttons.length <= targetIndex) {
        return 'failed';
      }
      await buttons[targetIndex].click();
    }
  }

  await setStance(page, stance);
  await setMaxEnemies(page, maxEnemies);
  await selectBattleFood(page);

  const battleBtn = page.getByRole('button', { name: 'Battle', exact: true });
  if (await battleBtn.count() === 0) {
    return 'failed';
  }
  await battleBtn.first().click();

  return 'battle_started';
}

/** Read battle screen state if a fight is in progress. */
export async function readBattleState(page: Page): Promise<BattleState> {
  const text = await pageText(page);
  const inBattle =
    text.includes('Run Away') ||
    (text.includes('Battle') && text.includes('HP'));

  let playerHpPercent: number | undefined;
  const hpMatch = text.match(/(\d+)\s*%\s*HP/i) ?? text.match(/HP[:\s]*(\d+)%/i);
  if (hpMatch) {
    playerHpPercent = Number.parseInt(hpMatch[1], 10);
  }

  return { inBattle, playerHpPercent, pageText: text };
}

/** Click Run Away during an active battle. */
export async function runAway(page: Page): Promise<CombatStepResult> {
  const fleeBtn = page.getByRole('button', { name: 'Run Away', exact: true });
  if (await fleeBtn.count() === 0) {
    return 'no_action';
  }
  await fleeBtn.click();
  return 'fled';
}

/** Click Hunt More to repeat after a battle completes. */
export async function huntMore(
  page: Page,
  allowInterrupt = false,
): Promise<CombatStepResult> {
  const huntMoreBtn = page.getByRole('button', { name: 'Hunt More', exact: true });
  if (await huntMoreBtn.count() === 0) {
    return 'no_action';
  }
  await huntMoreBtn.first().click();

  const dialog = await handleReplaceDialog(page, allowInterrupt);
  if (dialog === 'no_action') return 'no_action';
  if (dialog === 'failed') return 'failed';

  return 'hunt_more_clicked';
}

/**
 * Wait until hunt is active: Stop visible and hunt metrics or enemy cards appear.
 * During hunting, only metrics (Total Enemies Found) are shown — not card buttons.
 */
export async function waitForEnemies(
  page: Page,
  timeoutMs = 60_000,
): Promise<HuntState> {
  const huntStop = page.getByRole('button', { name: 'Stop', exact: true }).or(
    page.getByRole('button', { name: 'Cancel Hunt', exact: true }),
  );
  const huntMoreBtn = page.getByRole('button', { name: 'Hunt More', exact: true });

  await huntStop
    .or(huntMoreBtn)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => undefined);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readHuntState(page);
    if (hasHuntProgress(state)) {
      return state;
    }
    // ENEMIES NEARBY label is visible during active hunts — only treat selection
    // as ready once Stop is gone (post-hunt) or we already have metrics/cards.
    if (await hasPostHuntEnemySelectionReady(page)) {
      return state;
    }
    await page.waitForTimeout(500);
  }

  return readHuntState(page);
}

/**
 * After Stop: open ENEMIES NEARBY count panel or wait for legacy creature cards.
 * Returns HuntState with enemy name from detail panel when available.
 */
export async function prepareEnemyBattleSelection(
  page: Page,
  timeoutMs = 30_000,
): Promise<HuntState> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await readHuntState(page);
    if (state.enemies.length > 0) {
      return state;
    }

    if (await isEnemyDetailPanelOpen(page)) {
      const name = await readEnemyNameFromDetailPanel(page);
      if (name) {
        return { ...state, enemies: [{ name, index: 0 }] };
      }
      return state;
    }

    const countBtn = await findEnemiesNearbyCountButton(page);
    if (countBtn) {
      const opened = await openEnemiesNearbyPanel(page);
      if (opened === 'enemy_selected') {
        const refreshed = await readHuntState(page);
        if (refreshed.enemies.length > 0) {
          return refreshed;
        }
        const name = await readEnemyNameFromDetailPanel(page);
        if (name) {
          return { ...refreshed, enemies: [{ name, index: 0 }] };
        }
        return refreshed;
      }
    }

    await page.waitForTimeout(500);
  }

  return readHuntState(page);
}

/** @deprecated Use prepareEnemyBattleSelection */
export async function waitForEnemyCards(
  page: Page,
  timeoutMs = 30_000,
): Promise<HuntState> {
  return prepareEnemyBattleSelection(page, timeoutMs);
}
