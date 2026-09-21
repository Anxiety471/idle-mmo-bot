import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import { navigateTo } from '../browser.js';

function parseLevel(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Read total/combat level from profile (lightweight helper for combat loops). */
export async function readAccountLevels(
  page: Page,
  config: AppConfig,
): Promise<{ totalLevel?: number; combatLevel?: number }> {
  await navigateTo(page, config, '/profile');
  const text = await page.locator('body').innerText();
  return {
    totalLevel: parseLevel(text, /Total\s*Lv\.?\s*(\d+)/i),
    combatLevel: parseLevel(text, /Combat\s*(?:Lv\.?)?\s*(\d+)/i),
  };
}
