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
 * Deterministic skill gather/craft helpers (woodcutting, mining, fishing, etc.).
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
  // Do NOT match bare "Cheap Bait" — recipe lines always say "1 x Cheap Bait".
  /need(?:s)?\s+(?:more\s+)?(?:cheap\s+)?bait/i,
  /don't have.*bait/i,
  /do not have.*bait/i,
  /out of\s+(?:cheap\s+)?bait/i,
  /missing\s+(?:cheap\s+)?bait/i,
  /no\s+(?:cheap\s+)?bait/i,
  /you\s+need\s+bait/i,
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
  let settleTarget = busyIndicator.or(startButton);
  if (skill.defaultResource) {
    settleTarget = settleTarget.or(page.getByText(skill.defaultResource, { exact: true }));
  }

  await settleTarget
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
  // Skill cards use names like "Cod Lv. 1 2 EXP …", not the bare label.
  const resourceButton = page
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(resourceLabel)}\\b`, 'i') })
    .or(page.getByRole('button', { name: resourceLabel, exact: true }));
  if (await resourceButton.count() > 0) {
    await resourceButton.first().click({ force: true, timeout: 5000 });
    return true;
  }

  const resourceText = page.getByText(resourceLabel, { exact: true });
  if (await resourceText.count() > 0) {
    await resourceText.first().click({ force: true, timeout: 5000 }).catch(() => undefined);
    return true;
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Dismiss leftover modal overlays that intercept Start clicks. */
async function dismissBlockingOverlays(page: Page): Promise<void> {
  const overlay = page.locator('div.fixed.inset-0 div.absolute.inset-0.bg-immo');
  const dialog = page.getByText('Start a new action?');
  const blocking =
    (await overlay.count()) > 0 ||
    (await dialog.isVisible().catch(() => false));
  if (!blocking) {
    const close = page.getByRole('button', { name: 'Close', exact: true });
    if ((await close.count()) > 0 && (await close.first().isVisible().catch(() => false))) {
      await close.first().click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
    return;
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(150);
  }
  for (const name of ['Close', 'Cancel'] as const) {
    const btn = page.getByRole('button', { name, exact: true });
    if ((await btn.count()) > 0 && (await btn.first().isVisible().catch(() => false))) {
      await btn.first().click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
  }
}

/**
 * Fishing defaults quantity to 1 (one catch ~6s then idle). Batch or Max so
 * CURRENT ACTION outlives snapshot + gather grace (~30s).
 */
async function setGatherQuantityBatch(page: Page, batch = 8): Promise<void> {
  const qty = page.locator('input[name="quantity"]');
  if ((await qty.count()) === 0) return;
  const maxBtn = page.getByRole('button', { name: 'Max', exact: true });
  const canPerformText = await page.locator('body').innerText();
  const m = canPerformText.match(/you can perform this action\s+(\d+)\s+times/i);
  const available = m ? Number(m[1]) : batch;
  if (available >= 20 && (await maxBtn.count()) > 0) {
    await maxBtn.first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    return;
  }
  const value = String(Math.max(1, Math.min(batch, available || batch)));
  await qty.first().fill(value).catch(() => undefined);
  await qty.first().dispatchEvent('input').catch(() => undefined);
  await qty.first().dispatchEvent('change').catch(() => undefined);
  await page.waitForTimeout(200);
}

/** Prefer the largest visible Start — a 2x2 aria-hidden submit can steal .first(). */
async function clickStartButton(page: Page): Promise<boolean> {
  const starts = page.getByRole('button', { name: 'Start', exact: true });
  const count = await starts.count();
  if (count === 0) return false;
  let bestIdx = 0;
  let bestArea = -1;
  for (let i = 0; i < count; i++) {
    const box = await starts.nth(i).boundingBox().catch(() => null);
    const area = box ? box.width * box.height : 0;
    const disabled = await starts.nth(i).isDisabled().catch(() => true);
    if (disabled) continue;
    if (area > bestArea) {
      bestArea = area;
      bestIdx = i;
    }
  }
  await starts.nth(bestIdx).click({ force: true, timeout: 5000 });
  return true;
}

/** Idle MMO human-check: Verify → emoji challenge → confirm. */
async function solveHumanCaptchaIfPresent(page: Page): Promise<boolean> {
  const human = page.getByText(/make sure you're human/i);
  const verifyPeek = page.getByRole('button', { name: /^Verify$/i });
  if (!(await human.isVisible().catch(() => false)) && (await verifyPeek.count()) === 0) {
    return false;
  }

  if ((await verifyPeek.count()) > 0) {
    await verifyPeek.first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(800);
  }

  const body = await page.locator('body').innerText();
  const promptMatch = body.match(/Press the\s+(.+?)\s+emoji to continue/i);
  const targetName = (promptMatch?.[1] || '').trim().toLowerCase();

  const NAME_TO_EMOJI: Record<string, string> = {
    sun: '☀️',
    star: '⭐',
    moon: '🌙',
    cloud: '☁️',
    fire: '🔥',
    water: '💧',
    tree: '🌳',
    fish: '🐟',
    heart: '❤️',
    flower: '🌸',
    rainbow: '🌈',
  };
  const targetEmoji =
    NAME_TO_EMOJI[targetName] || NAME_TO_EMOJI[targetName.replace(/\s+emoji$/, '')];

  const optionButtons = page.locator('button');
  const count = await optionButtons.count();
  let clicked = false;
  for (let i = 0; i < count; i++) {
    const label = ((await optionButtons.nth(i).innerText().catch(() => '')) || '').trim();
    const aria = (await optionButtons.nth(i).getAttribute('aria-label').catch(() => '')) || '';
    const hay = `${label} ${aria}`;
    if (targetEmoji && hay.includes(targetEmoji)) {
      await optionButtons.nth(i).click({ force: true }).catch(() => undefined);
      clicked = true;
      break;
    }
    if (targetName && new RegExp(targetName, 'i').test(hay) && hay.length < 40) {
      await optionButtons.nth(i).click({ force: true }).catch(() => undefined);
      clicked = true;
      break;
    }
  }
  if (!clicked && targetEmoji) {
    const byText = page.getByText(targetEmoji, { exact: true });
    if ((await byText.count()) > 0) {
      await byText.first().click({ force: true }).catch(() => undefined);
      clicked = true;
    }
  }
  await page.waitForTimeout(1000);
  return clicked || (await verifyPeek.count()) > 0;
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

  // "You can perform this action N times" means materials (bait) are present.
  const canPerform = /you can perform this action\s+\d+\s+times/i.test(pageText);

  if (skill.requiresBait && !canPerform && detectMissingBait(pageText)) {
    return 'missing_requirement';
  }

  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  if (await startButton.count() === 0) {
    if (skill.requiresBait && !canPerform) {
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

  // Clear leftover modals BEFORE selecting a resource — Escape after select
  // can collapse the Cod panel and make Start look like missing bait.
  await dismissBlockingOverlays(page);

  if (!(await clickResource(page, resourceLabel))) {
    return 'failed';
  }

  await setGatherQuantityBatch(page);

  const startReadiness = await checkStartReadiness(page, skill);
  if (startReadiness !== 'ready') {
    return startReadiness;
  }

  if (!(await clickStartButton(page))) {
    return 'failed';
  }

  await page.waitForTimeout(500);
  const afterClickText = await page.locator('body').innerText();
  const canPerformAfter = /you can perform this action\s+\d+\s+times/i.test(afterClickText);
  if (skill.requiresBait && !canPerformAfter && detectMissingBait(afterClickText)) {
    return 'missing_requirement';
  }

  const dialog = page.getByText('Start a new action?');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (allowInterrupt) {
      const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
      if (await startAnyway.count() > 0) {
        await startAnyway.click({ force: true });
      } else {
        return 'failed';
      }
    } else {
      const closeButton = page.getByRole('button', { name: 'Close', exact: true });
      if (await closeButton.count() > 0) {
        await closeButton.click();
        return 'kept_current_action';
      }
      return 'failed';
    }
  }

  // Explicit CURRENT wait (settle alone can match idle Cod/Start chrome).
  let busyIndicator = page.getByText(CURRENT_ACTION_MARKER);
  await busyIndicator
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => undefined);

  let finalText = await page.locator('body').innerText();
  if (!finalText.includes(CURRENT_ACTION_MARKER)) {
    if (
      /make sure you're human|\bVerify\b/i.test(finalText) ||
      (await page.getByRole('button', { name: /^Verify$/i }).count()) > 0
    ) {
      await solveHumanCaptchaIfPresent(page);
      await setGatherQuantityBatch(page);
      const ready = await checkStartReadiness(page, skill);
      if (ready === 'ready') {
        await clickStartButton(page);
        if (allowInterrupt) {
          const dialog2 = page.getByText('Start a new action?');
          if (await dialog2.isVisible({ timeout: 1500 }).catch(() => false)) {
            const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
            if ((await startAnyway.count()) > 0) {
              await startAnyway.click({ force: true });
            }
          }
        }
        busyIndicator = page.getByText(CURRENT_ACTION_MARKER);
        await busyIndicator
          .first()
          .waitFor({ state: 'visible', timeout: GATHER_UI_SETTLE_MS })
          .catch(() => undefined);
        finalText = await page.locator('body').innerText();
      }
    }
  }

  if (!finalText.includes(CURRENT_ACTION_MARKER)) {
    return 'failed';
  }

  const activeResource = parseCurrentResource(finalText, skill.resources);
  if (activeResource && activeResource !== resourceLabel) {
    return 'already_busy';
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
