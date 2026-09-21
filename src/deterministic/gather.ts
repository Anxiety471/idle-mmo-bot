import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { ActiveGatherElsewhere, GatherRestartResult, GatherState } from '../types.js';
import { navigateTo } from '../browser.js';
import {
  GATHER_SKILL_IDS,
  getSkillConfig,
  resolveResource,
  type SkillConfig,
  type SkillId,
} from './skills.js';

/**
 * Deterministic skill gather helpers (woodcutting, mining, fishing).
 *
 * Selectors and labels are derived from live-tested UI flows (Sep 2025).
 * The Idle MMO web UI may change without notice — update selectors here
 * when flows break. Never invent outcomes; only report what the UI shows.
 *
 * CURRENT ACTION is global (one gather at a time) but only rendered on the
 * skill page that owns the active action — other skill pages look idle.
 */

const CURRENT_ACTION_MARKER = 'CURRENT ACTION';
/** Max time to wait for async gather panel after navigation. */
const GATHER_UI_SETTLE_MS = 10_000;
/** Shorter settle when probing other skill pages for a global busy check. */
const PROBE_SETTLE_MS = 3_000;

/** Bait-related phrases observed / expected when fishing without Cheap Bait. */
const BAIT_REQUIREMENT_PATTERNS = [
  /cheap bait/i,
  /need.*bait/i,
  /require.*bait/i,
  /don't have.*bait/i,
  /out of.*bait/i,
  /missing.*bait/i,
  /no bait/i,
];

/**
 * Wait until the skill page shows either an active action or idle controls.
 * CURRENT ACTION loads asynchronously after domcontentloaded (~2–3s).
 * Idle pages may show resource list (default resource label) before Start appears.
 */
async function waitForSkillUiSettled(
  page: Page,
  skill: SkillConfig,
  timeoutMs = GATHER_UI_SETTLE_MS,
): Promise<void> {
  const busyIndicator = page.getByText(CURRENT_ACTION_MARKER);
  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  const resourceLabel = page.getByText(skill.defaultResource, { exact: true });

  await busyIndicator
    .or(startButton)
    .or(resourceLabel)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {
      // Best-effort: if none appear, read state anyway rather than hanging forever.
    });
}

function parseCurrentResource(pageText: string, resources: string[]): string | undefined {
  if (!pageText.includes(CURRENT_ACTION_MARKER)) return undefined;

  const sectionStart = pageText.indexOf(CURRENT_ACTION_MARKER);
  const section = pageText.slice(sectionStart, sectionStart + 600);

  for (const resource of resources) {
    if (section.includes(resource)) return resource;
  }
  return undefined;
}

function detectMissingBait(pageText: string): boolean {
  return BAIT_REQUIREMENT_PATTERNS.some((pattern) => pattern.test(pageText));
}

async function clickResource(page: Page, resourceLabel: string): Promise<boolean> {
  const resourceButton = page.getByRole('button', { name: resourceLabel, exact: true });
  if (await resourceButton.count() > 0) {
    await resourceButton.first().click();
    return true;
  }

  const resourceText = page.getByText(resourceLabel, { exact: true });
  if (await resourceText.count() > 0) {
    await resourceText.first().click();
    return true;
  }

  return false;
}

/**
 * Probe other gather skill pages for CURRENT ACTION.
 * The game allows one gather action at a time; it only renders on the owning skill page.
 */
export async function findActiveGatherOnOtherSkill(
  page: Page,
  config: AppConfig,
  excludeSkillId: SkillId,
): Promise<ActiveGatherElsewhere | null> {
  for (const skillId of GATHER_SKILL_IDS) {
    if (skillId === excludeSkillId) continue;

    const otherSkill = getSkillConfig(skillId);
    await navigateTo(page, config, otherSkill.path);
    await waitForSkillUiSettled(page, otherSkill, PROBE_SETTLE_MS);

    const pageText = await page.locator('body').innerText();
    if (pageText.includes(CURRENT_ACTION_MARKER)) {
      return {
        skill: skillId,
        resource: parseCurrentResource(pageText, otherSkill.resources),
      };
    }
  }

  return null;
}

export interface ReadSkillStateOptions {
  /** When true and this page looks idle, probe other gather skill pages. */
  probeOtherSkills?: boolean;
}

/** Read skill gather page state without clicking anything. */
export async function readSkillState(
  page: Page,
  config: AppConfig,
  skillId: SkillId,
  options: ReadSkillStateOptions = {},
): Promise<GatherState> {
  const skill = getSkillConfig(skillId);
  await navigateTo(page, config, skill.path);
  await waitForSkillUiSettled(page, skill);
  const pageText = await page.locator('body').innerText();
  const busy = pageText.includes(CURRENT_ACTION_MARKER);
  const currentResource = busy ? parseCurrentResource(pageText, skill.resources) : undefined;

  let busyElsewhere: ActiveGatherElsewhere | undefined;
  if (!busy && options.probeOtherSkills) {
    const elsewhere = await findActiveGatherOnOtherSkill(page, config, skill.id);
    await navigateTo(page, config, skill.path);
    if (elsewhere) {
      busyElsewhere = elsewhere;
    }
  }

  return { busy, busyElsewhere, currentResource, pageText, skill: skill.id };
}

/** Backward-compatible woodcutting state reader. */
export async function readGatherState(page: Page, config: AppConfig): Promise<GatherState> {
  return readSkillState(page, config, 'woodcutting');
}

/** Poll until skill gather is idle or timeout elapses. */
export async function waitUntilIdle(
  page: Page,
  config: AppConfig,
  skillId: SkillId,
  timeoutMs = 120_000,
): Promise<GatherState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readSkillState(page, config, skillId);

  while ((state.busy || state.busyElsewhere) && Date.now() < deadline) {
    await page.waitForTimeout(config.pollMs);
    state = await readSkillState(page, config, skillId, { probeOtherSkills: true });
  }

  return state;
}

export interface RestartSkillOptions {
  skill: SkillId;
  resourceLabel?: string;
  /** When true, click "Start anyway" on the replace dialog. Default: false (Close). */
  allowInterrupt?: boolean;
  /** Reuse a recent readSkillState result to avoid duplicate navigation. */
  knownState?: GatherState;
}

/** @deprecated Use RestartSkillOptions */
export interface RestartGatherOptions {
  resourceLabel?: string;
  allowInterrupt?: boolean;
}

type StartReadiness = 'ready' | GatherRestartResult;

/**
 * Check whether Start can be clicked. Never clicks a disabled Start button
 * (fishing without bait exposes a disabled Start that would timeout).
 */
async function checkStartReadiness(page: Page, skill: SkillConfig): Promise<StartReadiness> {
  const pageText = await page.locator('body').innerText();

  if (skill.requiresBait && detectMissingBait(pageText)) {
    return 'missing_requirement';
  }

  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  if (await startButton.count() === 0) {
    if (skill.requiresBait) {
      return 'missing_requirement';
    }
    return 'failed';
  }

  if (await startButton.first().isDisabled()) {
    if (skill.requiresBait) {
      return 'missing_requirement';
    }
    return 'failed';
  }

  return 'ready';
}

/**
 * Restart gathering on the given skill/resource when idle.
 * If busy (locally or globally), returns without clicking Start.
 */
export async function restartSkillGather(
  page: Page,
  config: AppConfig,
  options: RestartSkillOptions,
): Promise<GatherRestartResult> {
  const skill = getSkillConfig(options.skill);
  const resourceLabel = resolveResource(skill, options.resourceLabel);
  const allowInterrupt = options.allowInterrupt ?? false;

  const state = options.knownState ?? await readSkillState(page, config, skill.id);
  if (state.busy) {
    return 'already_busy';
  }

  if (!allowInterrupt && state.busyElsewhere) {
    return 'another_action_active';
  }

  if (!allowInterrupt && !state.busyElsewhere && !options.knownState) {
    const probed = await findActiveGatherOnOtherSkill(page, config, skill.id);
    await navigateTo(page, config, skill.path);
    if (probed) {
      return 'another_action_active';
    }
  }

  if (!(await clickResource(page, resourceLabel))) {
    return 'failed';
  }

  const startReadiness = await checkStartReadiness(page, skill);
  if (startReadiness !== 'ready') {
    return startReadiness;
  }

  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  await startButton.first().click({ timeout: 5000 });

  await page.waitForTimeout(500);
  const afterClickText = await page.locator('body').innerText();
  if (skill.requiresBait && detectMissingBait(afterClickText)) {
    return 'missing_requirement';
  }

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

/** Backward-compatible woodcutting restart. */
export async function restartGather(
  page: Page,
  config: AppConfig,
  options: RestartGatherOptions = {},
): Promise<GatherRestartResult> {
  return restartSkillGather(page, config, {
    skill: 'woodcutting',
    resourceLabel: options.resourceLabel,
    allowInterrupt: options.allowInterrupt,
  });
}
