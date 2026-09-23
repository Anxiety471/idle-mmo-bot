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
import { solveHumanCaptchaIfPresent } from './human-check.js';

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

/** Slice of page text that describes the active CURRENT ACTION panel. */
function currentActionSection(pageText: string): string {
  if (!pageText.includes(CURRENT_ACTION_MARKER)) return '';
  const start = pageText.indexOf(CURRENT_ACTION_MARKER);
  return pageText.slice(start, start + 900);
}

/**
 * True when CURRENT ACTION looks like a real producing gather (not a stuck banner).
 * IdleMMO shows "Next item in M:SS" and a "+N" produced counter while mining.
 */
export function isHealthyProducingGather(
  pageText: string,
  resourceLabel?: string,
): boolean {
  const section = currentActionSection(pageText);
  if (!section) return false;
  if (resourceLabel && !section.toLowerCase().includes(resourceLabel.toLowerCase())) {
    return false;
  }
  return /next item in\s*\d/i.test(section) || /\+\d+(?:\.\d+)?[kK]?\b/.test(section);
}

/** Parse the "+N" produced counter from CURRENT ACTION when present. */
export function parseCurrentActionProducedCount(pageText: string): number | undefined {
  const section = currentActionSection(pageText);
  if (!section) return undefined;
  const m = section.match(/\+(\d+(?:\.\d+)?[kK]?)\b/);
  if (!m?.[1]) return undefined;
  const raw = m[1];
  const mk = raw.match(/^(\d+(?:\.\d+)?)[kK]$/i);
  if (mk) return Math.round(Number.parseFloat(mk[1]) * 1000);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
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
    await resourceButton.first().scrollIntoViewIfNeeded().catch(() => undefined);
    await resourceButton.first().click({ force: true, timeout: 5000 });
    await page.waitForTimeout(350);
    return true;
  }

  const resourceText = page.getByText(resourceLabel, { exact: true });
  if (await resourceText.count() > 0) {
    await resourceText.first().scrollIntoViewIfNeeded().catch(() => undefined);
    await resourceText.first().click({ force: true, timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(350);
    return true;
  }

  return false;
}

/** Wait for gather detail panel after resource select (qty field, Start, or can-perform copy). */
async function waitForResourcePanelReady(page: Page, timeoutMs = 4_000): Promise<void> {
  const qty = page.locator('input[name="quantity"]');
  const startButton = page.getByRole('button', { name: 'Start', exact: true });
  const canPerform = page.getByText(/you can perform this action\s+\d+\s+times/i);
  await qty
    .or(startButton)
    .or(canPerform)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => undefined);
  await page.waitForTimeout(150);
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
  // Max with tiny material stocks can leave Start disabled — only Max when stock is healthy.
  if (available >= 20 && (await maxBtn.count()) > 0) {
    await maxBtn.first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    return;
  }
  const capped = Number.isFinite(available) && available > 0 ? available : batch;
  const value = String(Math.max(1, Math.min(batch, capped)));
  await qty.first().fill(value).catch(() => undefined);
  await qty.first().dispatchEvent('input').catch(() => undefined);
  await qty.first().dispatchEvent('change').catch(() => undefined);
  await page.waitForTimeout(200);
}

async function forceQuantityOne(page: Page): Promise<void> {
  const qty = page.locator('input[name="quantity"]');
  if ((await qty.count()) === 0) return;
  await qty.first().fill('1').catch(() => undefined);
  await qty.first().dispatchEvent('input').catch(() => undefined);
  await qty.first().dispatchEvent('change').catch(() => undefined);
  await page.waitForTimeout(200);
}

async function confirmReplaceDialog(
  page: Page,
  allowInterrupt: boolean,
): Promise<'ok' | 'failed' | 'kept'> {
  const dialog = page.getByText(/Start a new action\?/i);
  if (!(await dialog.isVisible({ timeout: 2000 }).catch(() => false))) {
    return 'ok';
  }
  if (!allowInterrupt) {
    const closeButton = page.getByRole('button', { name: 'Close', exact: true });
    if ((await closeButton.count()) > 0) {
      await closeButton.first().click({ force: true }).catch(() => undefined);
    }
    return 'kept';
  }
  const startAnyway = page.getByRole('button', { name: /start anyway/i });
  if ((await startAnyway.count()) > 0) {
    await startAnyway.first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(400);
    return 'ok';
  }
  return 'failed';
}

/** Prefer the largest visible Start — a 2x2 aria-hidden submit can steal .first(). */
async function clickStartButton(page: Page): Promise<boolean> {
  const starts = page.getByRole('button', { name: 'Start', exact: true });
  const count = await starts.count();
  if (count === 0) return false;
  let bestIdx = -1;
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
  if (bestIdx < 0) return false;
  await starts.nth(bestIdx).click({ force: true, timeout: 5000 });
  return true;
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
        producedCount: parseCurrentActionProducedCount(pageText),
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
  const producedCount = busy ? parseCurrentActionProducedCount(pageText) : undefined;

  let busyElsewhere: ActiveGatherElsewhere | undefined;
  if (!busy && options.probeOtherSkills) {
    const elsewhere = await findActiveGatherOnOtherSkill(page, config, skill.id);
    await navigateTo(page, config, skill.path);
    if (elsewhere) {
      busyElsewhere = elsewhere;
    }
  }

  return { busy, busyElsewhere, currentResource, producedCount, pageText, skill: skill.id };
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
  /**
   * When true with allowInterrupt, Stop+re-Start even if already busy on the target
   * resource (stale busy / non-producing gather). Default: false keeps already_busy.
   */
  forceRestart?: boolean;
  /** Reuse a recent readSkillState result to avoid duplicate navigation. */
  knownState?: GatherState;
}

/** @deprecated Use RestartSkillOptions */
export interface RestartGatherOptions {
  resourceLabel?: string;
  allowInterrupt?: boolean;
}

type StartReadiness = 'ready' | GatherRestartResult;

interface GatherStartAttempt {
  startReadiness: GatherRestartResult;
  afterClickText: string;
  canPerformAfter: boolean;
  finalText: string;
  activeResource?: string;
}

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
    // No Start without explicit bait-missing copy → UI/panel failure, not missing bait.
    if (skill.requiresBait && !canPerform && detectMissingBait(pageText)) {
      return 'missing_requirement';
    }
    return 'failed';
  }

  if (await startButton.first().isDisabled()) {
    // Disabled Start: only treat as missing bait when the page explicitly says so
    // (or can-perform is absent AND bait-missing copy is present). Otherwise UI glitch.
    if (skill.requiresBait && detectMissingBait(pageText)) {
      return 'missing_requirement';
    }
    return 'failed';
  }

  return 'ready';
}

async function attemptGatherStart(
  page: Page,
  skill: SkillConfig,
  resourceLabel: string,
  allowInterrupt: boolean,
): Promise<GatherStartAttempt> {
  await dismissBlockingOverlays(page);
  await solveHumanCaptchaIfPresent(page);

  if (!(await clickResource(page, resourceLabel))) {
    return {
      startReadiness: 'failed',
      afterClickText: '',
      canPerformAfter: false,
      finalText: '',
    };
  }

  await waitForResourcePanelReady(page);
  await setGatherQuantityBatch(page);

  let startReadiness = await checkStartReadiness(page, skill);
  if (startReadiness !== 'ready') {
    await forceQuantityOne(page);
    startReadiness = await checkStartReadiness(page, skill);
  }
  if (startReadiness !== 'ready') {
    const pageText = await page.locator('body').innerText();
    return {
      startReadiness,
      afterClickText: pageText,
      canPerformAfter: /you can perform this action\s+\d+\s+times/i.test(pageText),
      finalText: pageText,
    };
  }

  if (!(await clickStartButton(page))) {
    await forceQuantityOne(page);
    if (!(await clickStartButton(page))) {
      const pageText = await page.locator('body').innerText();
      return {
        startReadiness: 'failed',
        afterClickText: pageText,
        canPerformAfter: /you can perform this action\s+\d+\s+times/i.test(pageText),
        finalText: pageText,
      };
    }
  }

  await page.waitForTimeout(500);
  await solveHumanCaptchaIfPresent(page);
  const afterClickText = await page.locator('body').innerText();
  const canPerformAfter = /you can perform this action\s+\d+\s+times/i.test(afterClickText);
  if (skill.requiresBait && !canPerformAfter && detectMissingBait(afterClickText)) {
    return {
      startReadiness: 'missing_requirement',
      afterClickText,
      canPerformAfter,
      finalText: afterClickText,
    };
  }

  const replace = await confirmReplaceDialog(page, allowInterrupt);
  if (replace === 'kept') {
    return {
      startReadiness: 'kept_current_action',
      afterClickText,
      canPerformAfter,
      finalText: afterClickText,
    };
  }
  if (replace === 'failed') {
    return {
      startReadiness: 'failed',
      afterClickText,
      canPerformAfter,
      finalText: afterClickText,
    };
  }

  let busyIndicator = page.getByText(CURRENT_ACTION_MARKER);
  await busyIndicator
    .first()
    .waitFor({ state: 'visible', timeout: GATHER_UI_SETTLE_MS })
    .catch(() => undefined);
  let finalText = await page.locator('body').innerText();

  if (!finalText.includes(CURRENT_ACTION_MARKER) && allowInterrupt) {
    await forceQuantityOne(page);
    if (await clickStartButton(page)) {
      await page.waitForTimeout(400);
      await confirmReplaceDialog(page, true);
      busyIndicator = page.getByText(CURRENT_ACTION_MARKER);
      await busyIndicator
        .first()
        .waitFor({ state: 'visible', timeout: GATHER_UI_SETTLE_MS })
        .catch(() => undefined);
      finalText = await page.locator('body').innerText();
    }
  }

  const activeResource = finalText.includes(CURRENT_ACTION_MARKER)
    ? parseCurrentResource(finalText, skill.resources)
    : undefined;

  if (!finalText.includes(CURRENT_ACTION_MARKER)) {
    return {
      startReadiness: 'failed',
      afterClickText,
      canPerformAfter,
      finalText,
      activeResource,
    };
  }

  if (activeResource && activeResource !== resourceLabel) {
    return {
      startReadiness: 'already_busy',
      afterClickText,
      canPerformAfter,
      finalText,
      activeResource,
    };
  }

  return {
    startReadiness: 'restarted',
    afterClickText,
    canPerformAfter,
    finalText,
    activeResource,
  };
}


/** Stop an active gather CURRENT ACTION when present (needed to force-restart stale mining). */
async function tryStopCurrentGather(page: Page): Promise<boolean> {
  const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
  let clicked = false;
  if ((await stopBtn.count()) > 0 && (await stopBtn.first().isVisible().catch(() => false))) {
    await stopBtn.first().click({ force: true }).catch(() => undefined);
    clicked = true;
    await page.waitForTimeout(400);
  } else {
    // IdleMMO CURRENT ACTION panel often uses an X / Cancel rather than "Stop".
    const cancel = page.getByRole('button', { name: /^(Cancel|Close|×|✕)$/i });
    for (let i = 0; i < Math.min(await cancel.count(), 4); i++) {
      if (await cancel.nth(i).isVisible().catch(() => false)) {
        await cancel.nth(i).click({ force: true }).catch(() => undefined);
        clicked = true;
        await page.waitForTimeout(300);
        break;
      }
    }
  }
  if (!clicked) return false;
  // Confirm dialog often repeats the Stop label.
  const confirm = page.getByRole('button', { name: /^(Stop|Confirm|Yes)$/i });
  for (let i = 0; i < (await confirm.count()); i++) {
    if (await confirm.nth(i).isVisible().catch(() => false)) {
      await confirm.nth(i).click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
      break;
    }
  }
  // Wait briefly for CURRENT ACTION to clear.
  const busy = page.getByText(CURRENT_ACTION_MARKER);
  await busy
    .first()
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => undefined);
  return true;
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
  const forceRestart = options.forceRestart ?? false;

  let state = options.knownState ?? await readSkillState(page, config, skill.id);
  if (state.busy && !allowInterrupt) {
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

  // Ensure we're on the skill page (snapshot probes may leave us elsewhere).
  await navigateTo(page, config, skill.path);
  await waitForSkillUiSettled(page, skill);

  // Same-resource busy: healthy gather → already_busy unless forceRestart (stale coal).
  // Cross-skill interrupt usually sees this page as idle (CURRENT ACTION elsewhere).
  if (state.busy && allowInterrupt) {
    const onTarget =
      !state.currentResource || state.currentResource === resourceLabel;
    if (onTarget && !forceRestart) {
      return 'already_busy';
    }
    if (onTarget && forceRestart) {
      // Inventory scrape can under-count while mining is healthy (Next item in / +N).
      // Do not tear down a producing gather — that resets the long idle timer.
      const liveText = await page.locator('body').innerText().catch(() => state.pageText);
      if (isHealthyProducingGather(liveText, resourceLabel)) {
        return 'already_busy';
      }
      await tryStopCurrentGather(page);
      await waitForSkillUiSettled(page, skill);
      state = await readSkillState(page, config, skill.id);
      // If still busy after Stop, fall through to attemptGatherStart (Start anyway).
    }
  }

  // Mining shares fish-style Start flakiness (qty/disabled Start/captcha); retry a few times.
  const maxAttempts = skill.requiresBait || skill.id === 'mining' ? 3 : 1;
  let lastResult: GatherRestartResult = 'failed';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await navigateTo(page, config, skill.path);
      await waitForSkillUiSettled(page, skill);
    }

    const attemptResult = await attemptGatherStart(page, skill, resourceLabel, allowInterrupt);
    lastResult = attemptResult.startReadiness;

    if (lastResult === 'restarted' || lastResult === 'already_busy' || lastResult === 'kept_current_action') {
      return lastResult;
    }
    if (lastResult === 'missing_requirement') {
      return lastResult;
    }
  }

  return lastResult;
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
