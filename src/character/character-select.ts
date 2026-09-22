import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import { navigateTo } from '../browser.js';
import { characterNamesMatch } from './paths.js';

/**
 * Character list / switch / create flows for multi-character accounts.
 *
 * UI path (wiki + nav discovery — selectors may need updates when the game changes):
 *
 * | Step | Source | Notes |
 * |------|--------|-------|
 * | Limits | [Getting Started](https://wiki.idle-mmo.com/getting-started/introduction) | Up to **5** characters per account; **3 active** at once |
 * | Create | Same wiki — "Create Another Character" | Pick a class matching the alt's role (Miner, Angler, Chef, …) |
 * | Nav | `combat.ts` NAV_CHROME | In-game nav exposes a **Character** button |
 * | Expected flow | Best-effort | Character nav → roster → select card / **Play** → active session |
 * | Active name | `/profile` | Profile page text / heading used to verify selection |
 *
 * Env knobs:
 * - `SKIP_CHARACTER_ENSURE=true` — bypass bootstrap (legacy/debug)
 * - `CHARACTER_SELECTOR_ROUTE=/path` — navigate directly instead of Character nav click
 * - `CREATE_CHARACTER_IF_MISSING=true` — create alt with safe defaults (no membership/token spend)
 * - `CHARACTER_DEFAULT_CLASS=Miner` — class when creating (default Miner; gold-only, no tokens)
 *
 * TODO: Record exact selectors from a live codegen session against the character roster modal.
 */

const CHARACTER_NAV_LABEL = 'Character';
const CREATE_CHARACTER_PATTERN = /Create (Another )?Character/i;
const PLAY_BUTTON_PATTERN = /^Play$/i;
const MEMBERSHIP_SPEND_PATTERN = /membership|purchase with tokens?|spend tokens?/i;

export interface CharacterInfo {
  name: string;
  /** True when roster row suggests this character is currently playing. */
  active?: boolean;
}

export type CharacterEnsureOutcome =
  | 'already_active'
  | 'switched'
  | 'created'
  | 'skipped'
  | 'failed';

export interface CharacterEnsureResult {
  outcome: CharacterEnsureOutcome;
  activeCharacter?: string;
  message?: string;
}

function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

export async function navigateToCharacterSelect(page: Page, config: AppConfig): Promise<void> {
  const route = process.env.CHARACTER_SELECTOR_ROUTE?.trim();
  if (route) {
    await navigateTo(page, config, route);
    return;
  }

  await navigateTo(page, config, '/profile');
  const charBtn = page.getByRole('button', { name: CHARACTER_NAV_LABEL, exact: true });
  if ((await charBtn.count()) > 0 && (await charBtn.first().isVisible())) {
    await charBtn.first().click();
    await page.waitForTimeout(500);
  }
}

/** Read the active character name from /profile (best-effort). */
export async function readActiveCharacterName(
  page: Page,
  config: AppConfig,
): Promise<string | undefined> {
  await navigateTo(page, config, '/profile');
  const text = await page.locator('body').innerText();

  const labeled = text.match(/Character\s*Name\s*:?\s*([^\n]+)/i);
  if (labeled?.[1]?.trim()) return labeled[1].trim();

  try {
    const heading = page.getByRole('heading').first();
    if ((await heading.count()) > 0) {
      const h = (await heading.innerText()).trim();
      if (h && !/profile|settings|idle\s*mmo|bank|gold|tokens/i.test(h)) {
        return h;
      }
    }
  } catch {
    // Best-effort — fall through.
  }

  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean);
  if (firstLine && firstLine.length >= 3 && firstLine.length <= 24) {
    if (!/^(Profile|Gold|Tokens|Total|Combat|Settings|Menu)$/i.test(firstLine)) {
      return firstLine;
    }
  }

  return undefined;
}

/** List visible characters on the roster screen (best-effort scrape). */
export async function listCharacters(page: Page, config: AppConfig): Promise<CharacterInfo[]> {
  await navigateToCharacterSelect(page, config);
  const characters: CharacterInfo[] = [];
  const seen = new Set<string>();

  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    let label = '';
    try {
      label = (await btn.innerText()).trim();
    } catch {
      continue;
    }
    if (!label || label.length < 3) continue;
    if (/^(Character|Create|Play|Settings|Menu|Close|Cancel|Profile)$/i.test(label.split('\n')[0] ?? '')) {
      continue;
    }
    if (!/\bLv\.?\s*\d+/i.test(label) && !/Main Character|Alt Character/i.test(label)) {
      continue;
    }

    const name = (label.split('\n')[0] ?? label).trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    characters.push({
      name,
      active: /Playing|Active|Currently/i.test(label),
    });
  }

  return characters;
}

/** Select a character by display name; returns false when roster control is not found. */
export async function selectCharacterByName(
  page: Page,
  config: AppConfig,
  name: string,
): Promise<boolean> {
  await navigateToCharacterSelect(page, config);

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const card = page
    .getByRole('button', { name: new RegExp(escaped, 'i') })
    .or(page.getByText(name, { exact: true }));

  if ((await card.count()) === 0) return false;
  await card.first().click();

  const playBtn = page.getByRole('button', { name: PLAY_BUTTON_PATTERN });
  if ((await playBtn.count()) > 0 && (await playBtn.first().isVisible())) {
    await playBtn.first().click();
  }

  await page.waitForTimeout(1000);
  return true;
}

/**
 * Create a new character with safe defaults.
 * Refuses flows that mention membership/token spend.
 */
export async function createCharacter(
  page: Page,
  config: AppConfig,
  options: { name: string; className?: string },
): Promise<boolean> {
  await navigateToCharacterSelect(page, config);

  let createBtn = page.getByRole('button', { name: CREATE_CHARACTER_PATTERN });
  if ((await createBtn.count()) === 0) {
    createBtn = page.getByText(CREATE_CHARACTER_PATTERN);
  }
  if ((await createBtn.count()) === 0) return false;
  await createBtn.first().click();

  const bodyText = await page.locator('body').innerText();
  if (MEMBERSHIP_SPEND_PATTERN.test(bodyText)) {
    const cancel = page.getByRole('button', { name: /Cancel|Close|Back/i });
    if ((await cancel.count()) > 0) await cancel.first().click();
    return false;
  }

  const nameInput = page.locator('input[name="name"], input[placeholder*="name" i]');
  if ((await nameInput.count()) > 0) {
    await nameInput.first().fill(options.name);
  }

  const className =
    options.className?.trim() || process.env.CHARACTER_DEFAULT_CLASS?.trim() || 'Miner';
  const classBtn = page.getByRole('button', { name: new RegExp(className, 'i') });
  if ((await classBtn.count()) > 0) {
    await classBtn.first().click();
  }

  const confirm = page.getByRole('button', { name: /^(Create|Confirm|Start)$/i });
  if ((await confirm.count()) > 0) {
    await confirm.first().click();
  }

  await page.waitForTimeout(1500);
  return true;
}

/**
 * Ensure the configured CHARACTER_NAME is active before snapshots run.
 * No-op when CHARACTER_NAME is unset (legacy single-character mode).
 */
export async function ensureActiveCharacter(
  page: Page,
  config: AppConfig,
): Promise<CharacterEnsureResult> {
  if (parseEnvBool(process.env.SKIP_CHARACTER_ENSURE, false)) {
    return { outcome: 'skipped', message: 'SKIP_CHARACTER_ENSURE=true' };
  }

  const target = config.characterName?.trim();
  if (!target) {
    return { outcome: 'skipped', message: 'CHARACTER_NAME unset — legacy single-character mode' };
  }

  const active = await readActiveCharacterName(page, config);
  if (characterNamesMatch(active, target)) {
    return { outcome: 'already_active', activeCharacter: active };
  }

  const switched = await selectCharacterByName(page, config, target);
  if (switched) {
    const after = await readActiveCharacterName(page, config);
    if (characterNamesMatch(after, target)) {
      return { outcome: 'switched', activeCharacter: after };
    }
  }

  if (parseEnvBool(process.env.CREATE_CHARACTER_IF_MISSING, false)) {
    const created = await createCharacter(page, config, { name: target });
    if (created) {
      const afterCreate = await readActiveCharacterName(page, config);
      if (characterNamesMatch(afterCreate, target)) {
        return { outcome: 'created', activeCharacter: afterCreate ?? target };
      }
      return { outcome: 'created', activeCharacter: target, message: 'Created; verify active name on profile' };
    }
  }

  return {
    outcome: 'failed',
    message: `Could not activate character "${target}" (active: ${active ?? 'unknown'})`,
  };
}
