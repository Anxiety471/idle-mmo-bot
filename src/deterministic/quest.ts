import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { QuestInfo, QuestState, QuestStepResult } from '../types.js';
import { navigateTo } from '../browser.js';

/**
 * Deterministic quest click-path helpers.
 *
 * Flow: /quests → open card → Talk → dialogue → Overview → Turn In.
 * UI labels and structure may change — update selectors when flows break.
 * Never invent quest completion; only act on visible enabled buttons.
 */

const QUESTS_PATH = '/quests';
/** Max time to wait for async quest UI after navigation (~2–3s observed). */
const QUEST_UI_SETTLE_MS = 10_000;
/** Brief pause after tab switch for quest list to refresh. */
const TAB_SWITCH_SETTLE_MS = 500;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match tab labels like "Accepted" or "Accepted 1", "Pending Nearby 3". */
function questTabPattern(tabName: string): RegExp {
  return new RegExp(`^${escapeRegex(tabName)}(?:\\s+\\d+)?$`);
}

/**
 * Wait until quest tab buttons are visible after domcontentloaded.
 * Tabs load asynchronously (~2–3s); switching too early misses Accepted list.
 */
export async function waitForQuestTabsSettled(page: Page, timeoutMs = QUEST_UI_SETTLE_MS): Promise<void> {
  const tabs = page
    .getByRole('button', { name: questTabPattern('Accepted') })
    .or(page.getByRole('button', { name: questTabPattern('Pending Nearby') }))
    .or(page.getByRole('button', { name: questTabPattern('Completed') }));

  await tabs
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {
      // Best-effort: proceed rather than hang forever.
    });
}

/** Wait for a quest card button (substring name match) to appear in the current list. */
export async function waitForQuestCard(
  page: Page,
  title: string,
  timeoutMs = QUEST_UI_SETTLE_MS,
): Promise<boolean> {
  const card = page.getByRole('button', { name: title });
  try {
    await card.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/** Navigate to quests and scrape visible quest cards. */
export async function readQuestState(page: Page, config: AppConfig): Promise<QuestState> {
  await navigateTo(page, config, QUESTS_PATH);
  const text = await pageText(page);

  const quests: QuestInfo[] = [];
  const turnInButtons = page.getByRole('button', { name: 'Turn In', exact: true });
  const turnInCount = await turnInButtons.count();

  // Quest titles appear as clickable cards/buttons; scan common patterns
  const questTitlePattern = /(Wood for the Hearth|[\w\s']{3,40})/g;
  const seen = new Set<string>();

  for (const match of text.matchAll(/([A-Z][\w\s']{2,40})\n/g)) {
    const title = match[1].trim();
    if (seen.has(title) || title.length < 4) continue;
    if (['Overview', 'Talk', 'Turn In', 'Quests'].includes(title)) continue;
    seen.add(title);

    const progressMatch = text.match(new RegExp(`${title}[\\s\\S]*?(\\w[\\w\\s]*\\d+\\s*/\\s*\\d+)`, 'i'));
    const canTurnIn = turnInCount > 0 && text.includes(title);

    quests.push({
      title,
      progress: progressMatch?.[1]?.trim(),
      canTurnIn,
      isOpen: text.includes(title) && (text.includes('Overview') || text.includes('Talk')),
    });
  }

  return { quests, pageText: text };
}

export interface OpenQuestOptions {
  /** Skip navigation when already on /quests. */
  skipNavigate?: boolean;
}

/** Open a quest card by title. */
export async function openQuest(
  page: Page,
  config: AppConfig,
  title: string,
  options: OpenQuestOptions = {},
): Promise<QuestStepResult> {
  if (!options.skipNavigate) {
    await navigateTo(page, config, QUESTS_PATH);
  }

  // Substring match on button accessible name (works once tab list is visible).
  const card = page.getByRole('button', { name: title });
  if (await card.count() === 0) {
    return 'failed';
  }
  await card.first().click();
  return 'opened';
}

/**
 * Switch quest list tab (e.g. Accepted, Pending Nearby, Completed).
 * Tab buttons include optional counts: "Accepted 1", "Pending Nearby 3".
 */
export async function switchQuestTab(page: Page, tabName: string): Promise<QuestStepResult> {
  const pattern = questTabPattern(tabName);

  const tabByRole = page.getByRole('button', { name: pattern });
  if (await tabByRole.count() > 0) {
    await tabByRole.first().click();
    await page.waitForTimeout(TAB_SWITCH_SETTLE_MS);
    return 'opened';
  }

  // Fallback: scan visible buttons for matching label text
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const label = (await buttons.nth(i).innerText()).trim();
    if (pattern.test(label)) {
      await buttons.nth(i).click();
      await page.waitForTimeout(TAB_SWITCH_SETTLE_MS);
      return 'opened';
    }
  }

  return 'no_action';
}

export interface TurnInQuestOptions {
  title: string;
  /** Quest tab to open first, e.g. "Accepted". */
  tab?: string;
  /** Progress item to read from Overview, e.g. "Oak Log". */
  progressItem?: string;
}

export interface TurnInQuestOutcome {
  result: QuestStepResult;
  progress?: string;
}

/**
 * Open a quest and turn in when the Turn In button is enabled.
 * Does not invent completion — only clicks when the button is enabled.
 */
export async function turnInQuestWhenReady(
  page: Page,
  config: AppConfig,
  options: TurnInQuestOptions,
): Promise<TurnInQuestOutcome> {
  await navigateTo(page, config, QUESTS_PATH);
  await waitForQuestTabsSettled(page);

  if (options.tab) {
    const tabResult = await switchQuestTab(page, options.tab);
    if (tabResult !== 'opened') {
      return { result: 'failed' };
    }
  }

  if (!(await waitForQuestCard(page, options.title))) {
    return { result: 'failed' };
  }

  const opened = await openQuest(page, config, options.title, { skipNavigate: true });
  if (opened === 'failed') {
    return { result: 'failed' };
  }

  let progress: string | undefined;
  if (options.progressItem) {
    progress = await readQuestProgress(page, options.progressItem);
  }

  if (await isTurnInEnabled(page)) {
    return { result: await turnInQuest(page), progress };
  }

  return { result: 'in_progress', progress };
}

/** Wait for quest detail controls after opening a card. */
export async function waitForQuestDetail(
  page: Page,
  timeoutMs = QUEST_UI_SETTLE_MS,
): Promise<boolean> {
  const detail = page
    .getByRole('button', { name: 'Talk', exact: true })
    .or(page.getByRole('button', { name: 'Accept', exact: true }))
    .or(page.getByRole('button', { name: 'Overview', exact: true }));

  try {
    await detail.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Navigate to /quests and confirm replacing an active gather when needed. */
export async function navigateToQuestsInterrupting(
  page: Page,
  config: AppConfig,
): Promise<'ok' | 'blocked'> {
  await navigateTo(page, config, QUESTS_PATH);

  const dialog = page.getByText('Start a new action?');
  if (!(await dialog.isVisible({ timeout: 2000 }).catch(() => false))) {
    return 'ok';
  }

  const startAnyway = page.getByRole('button', { name: 'Start anyway', exact: true });
  if (await startAnyway.count() > 0) {
    await startAnyway.click();
    return 'ok';
  }

  const closeButton = page.getByRole('button', { name: 'Close', exact: true });
  if (await closeButton.count() > 0) {
    await closeButton.click();
    return 'blocked';
  }

  return 'blocked';
}

const KNOWN_ACCEPT_DIALOGUES = [
  "Right. I'll fetch the logs.",
  "I'll help with the hearth.",
] as const;

async function clickDialogueLine(page: Page, line: string): Promise<boolean> {
  const option = page
    .getByRole('button', { name: line, exact: true })
    .or(page.getByText(line, { exact: true }));
  if (await option.count() === 0) return false;
  await option.first().click();
  return true;
}

/** Click Talk and select a dialogue option if a picker is shown. */
export async function talkQuest(
  page: Page,
  dialogueOption?: string,
): Promise<QuestStepResult> {
  const acceptBtn = page.getByRole('button', { name: 'Accept', exact: true });
  if (await acceptBtn.count() > 0 && !(await acceptBtn.first().isDisabled())) {
    await acceptBtn.click();
    return 'talked';
  }

  const talkBtn = page.getByRole('button', { name: 'Talk', exact: true });
  if (await talkBtn.count() === 0) {
    return 'no_action';
  }
  await talkBtn.click();
  await page.waitForTimeout(TAB_SWITCH_SETTLE_MS);

  const dialogueLines = [
    ...(dialogueOption ? [dialogueOption] : []),
    ...KNOWN_ACCEPT_DIALOGUES.filter((line) => line !== dialogueOption),
  ];

  for (const line of dialogueLines) {
    if (await clickDialogueLine(page, line)) {
      return 'talked';
    }
  }

  const talkStillVisible = await page.getByRole('button', { name: 'Talk', exact: true }).count();
  if (talkStillVisible === 0) {
    return 'talked';
  }

  return 'no_action';
}

/** Click Turn In only when the button is enabled. */
export async function turnInQuest(page: Page): Promise<QuestStepResult> {
  const turnInBtn = page.getByRole('button', { name: 'Turn In', exact: true });
  if (await turnInBtn.count() === 0) {
    return 'no_action';
  }

  const isDisabled = await turnInBtn.first().isDisabled();
  if (isDisabled) {
    return 'in_progress';
  }

  await turnInBtn.first().click();
  return 'turned_in';
}

/** Read quest progress from Overview tab text. */
export async function readQuestProgress(page: Page, itemName: string): Promise<string | undefined> {
  const overview = page.getByRole('button', { name: 'Overview', exact: true });
  if (await overview.count() > 0) {
    await overview.click();
  }

  const text = await pageText(page);
  const match = text.match(new RegExp(`${itemName}\\s+(\\d+)\\s*/\\s*(\\d+)`, 'i'));
  if (match) {
    return `${itemName} ${match[1]} / ${match[2]}`;
  }
  return undefined;
}

/** Check whether Turn In is currently enabled. */
export async function isTurnInEnabled(page: Page): Promise<boolean> {
  const turnInBtn = page.getByRole('button', { name: 'Turn In', exact: true });
  if (await turnInBtn.count() === 0) return false;
  return !(await turnInBtn.first().isDisabled());
}
