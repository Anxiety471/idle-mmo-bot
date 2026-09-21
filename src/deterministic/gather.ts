import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { GatherRestartResult, GatherState } from '../types.js';
import { navigateTo } from '../browser.js';

/**
 * Deterministic woodcutting gather helpers.
 *
 * Selectors and labels are derived from live-tested UI flows (Sep 2025).
 * The Idle MMO web UI may change without notice — update selectors here
 * when flows break. Never invent outcomes; only report what the UI shows.
 */

const WOODCUTTING_PATH = '/skills/view/woodcutting';
const CURRENT_ACTION_MARKER = 'CURRENT ACTION';
const DEFAULT_RESOURCE = 'Oak Log';

/** Read gather page state without clicking anything. */
export async function readGatherState(page: Page, config: AppConfig): Promise<GatherState> {
  await navigateTo(page, config, WOODCUTTING_PATH);
  const pageText = await page.locator('body').innerText();
  const busy = pageText.includes(CURRENT_ACTION_MARKER);

  let currentResource: string | undefined;
  if (busy) {
    const match = pageText.match(/CURRENT ACTION[\s\S]*?(\w[\w\s]*Log)/i);
    currentResource = match?.[1]?.trim();
  }

  return { busy, currentResource, pageText };
}

/** Poll until gather is idle or timeout elapses. */
export async function waitUntilIdle(
  page: Page,
  config: AppConfig,
  timeoutMs = 120_000,
): Promise<GatherState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readGatherState(page, config);

  while (state.busy && Date.now() < deadline) {
    await page.waitForTimeout(config.pollMs);
    state = await readGatherState(page, config);
  }

  return state;
}

export interface RestartGatherOptions {
  resourceLabel?: string;
  /** When true, click "Start anyway" on the replace dialog. Default: false (Close). */
  allowInterrupt?: boolean;
}

/**
 * Restart woodcutting on the given resource when idle.
 * If busy, returns immediately without clicking Start.
 */
export async function restartGather(
  page: Page,
  config: AppConfig,
  options: RestartGatherOptions = {},
): Promise<GatherRestartResult> {
  const resourceLabel = options.resourceLabel ?? DEFAULT_RESOURCE;
  const allowInterrupt = options.allowInterrupt ?? false;

  const state = await readGatherState(page, config);
  if (state.busy) {
    return 'already_busy';
  }

  // Select resource (e.g. Oak Log)
  const resourceButton = page.getByRole('button', { name: resourceLabel, exact: true });
  if (await resourceButton.count() === 0) {
    const resourceText = page.getByText(resourceLabel, { exact: true });
    if (await resourceText.count() === 0) {
      return 'failed';
    }
    await resourceText.first().click();
  } else {
    await resourceButton.first().click();
  }

  // Click Start
  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  if (await startButton.count() === 0) {
    return 'failed';
  }
  await startButton.first().click();

  // Handle "Start a new action?" dialog if it appears
  const dialog = page.getByText('Start a new action?');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (allowInterrupt) {
      const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
      if (await startAnyway.count() > 0) {
        await startAnyway.click();
        return 'restarted';
      }
      return 'failed';
    }

    const closeButton = page.getByRole('button', { name: 'Close', exact: true });
    if (await closeButton.count() > 0) {
      await closeButton.click();
      return 'kept_current_action';
    }
    return 'failed';
  }

  return 'restarted';
}
