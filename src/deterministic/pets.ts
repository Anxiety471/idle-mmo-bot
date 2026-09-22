/**
 * Pet management — claim finished work, feed carefully, battle or sleep.
 *
 * Live UI selectors are resilient (role/text). Pets page: /pets.
 * Feeding tip from community guides: avoid blind Max (can waste one food unit).
 *
 * Maintenance (claim/feed/battle/sleep) is safe while the character is gathering.
 * Equip is reserved for idle ticks so the character receives the pet boost.
 */
import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import { navigateTo } from '../browser.js';

export type PetsStepResult = string;

export interface ManagePetsOptions {
  /**
   * When true (default), also click Equip if shown.
   * Pass false while gatherBusy/inBattle so maintenance can run without equipping mid-action.
   */
  allowEquip?: boolean;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickFirst(
  page: Page,
  pattern: RegExp,
  timeoutMs = 2500,
): Promise<boolean> {
  const btn = page.getByRole('button', { name: pattern });
  if ((await btn.count()) === 0) return false;
  try {
    await btn.first().click({ timeout: timeoutMs });
    await sleep(400);
    return true;
  } catch {
    return false;
  }
}

async function tryFeedOnce(page: Page): Promise<boolean> {
  if (!(await clickFirst(page, /^\s*feed\s*$/i))) return false;
  await sleep(500);
  // Prefer a cooked food chip if visible.
  const food = page.getByText(/Cooked Cod|Cooked Salmon|Cooked Tuna|Cooked/i).first();
  if (await food.isVisible({ timeout: 1500 }).catch(() => false)) {
    await food.click({ timeout: 2000 }).catch(() => undefined);
    await sleep(300);
  }
  const maxBtn = page.getByRole('button', { name: /^\s*max\s*$/i });
  if ((await maxBtn.count()) > 0) {
    await maxBtn.first().click({ timeout: 1500 }).catch(() => undefined);
    await sleep(200);
    // Community tip: Max can overshoot — nudge quantity down by one when possible.
    const minus = page.getByRole('button', { name: /^[-−]$|^\s*-\s*$/ });
    if ((await minus.count()) > 0) {
      await minus.first().click({ timeout: 1000 }).catch(() => undefined);
      await sleep(150);
    }
  }
  const use = page.getByRole('button', { name: /^\s*use\s*$|^\s*confirm\s*$|^\s*feed\s*$/i });
  if ((await use.count()) > 0) {
    await use.first().click({ timeout: 2000 }).catch(() => undefined);
    await sleep(400);
    return true;
  }
  return true;
}

async function openPetsPage(page: Page, config: AppConfig): Promise<PetsStepResult | null> {
  try {
    await navigateTo(page, config, '/pets');
    await sleep(Math.max(800, config.pollMs));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `failed:navigate:${message.slice(0, 80)}`;
  }

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/no pets|you don't have any pets|don.?t have any pets|hatch an egg/i.test(body)) {
    return 'no_pets';
  }
  return null;
}

/**
 * Maintenance only: claim / sleep / feed / battle — never Equip.
 * Safe to run while the character is gathering or otherwise acting.
 */
export async function maintainPets(page: Page, config: AppConfig): Promise<PetsStepResult> {
  return managePets(page, config, { allowEquip: false });
}

/**
 * Idle-only equip tick — keep a pet equipped for the character boost.
 */
export async function equipPet(page: Page, config: AppConfig): Promise<PetsStepResult> {
  const early = await openPetsPage(page, config);
  if (early) return early;

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (await clickFirst(page, /^\s*equip\s*$/i)) {
    return 'ok:equip';
  }
  if (/equipped|pet|stamina|happiness|mastery/i.test(body)) {
    return 'inspected';
  }
  return 'no_action';
}

/**
 * Best-effort pets tick.
 * Maintenance always; Equip only when `allowEquip` is true (default true for backward compat).
 */
export async function managePets(
  page: Page,
  config: AppConfig,
  options: ManagePetsOptions = {},
): Promise<PetsStepResult> {
  const allowEquip = options.allowEquip !== false;

  const early = await openPetsPage(page, config);
  if (early) return early;

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  const actions: string[] = [];

  if (await clickFirst(page, /claim|collect|complete|finish/i)) {
    actions.push('claimed');
  }

  // Prefer recovering stamina via Sleep when the control is available.
  if (await clickFirst(page, /^\s*sleep\s*$/i)) {
    actions.push('sleep');
  }

  if (await tryFeedOnce(page)) {
    actions.push('fed');
  }

  // Send an idle pet to battle when Battle is available (does not spend membership).
  if (await clickFirst(page, /^\s*battle\s*$/i)) {
    actions.push('battle');
    // Confirm location/start if a dialog appears.
    await clickFirst(page, /^\s*start\s*$|^\s*confirm\s*$|^\s*battle\s*$/i);
  }

  if (allowEquip && (await clickFirst(page, /^\s*equip\s*$/i))) {
    actions.push('equip');
  }

  if (actions.length === 0) {
    // Page opened and pets exist — count as managed maintenance peek.
    if (/pet|stamina|happiness|mastery/i.test(body)) {
      return 'inspected';
    }
    return 'no_action';
  }

  return `ok:${actions.join('+')}`;
}
