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

/** Open a quest card by title. */
export async function openQuest(
  page: Page,
  config: AppConfig,
  title: string,
): Promise<QuestStepResult> {
  await navigateTo(page, config, QUESTS_PATH);

  const card = page.getByRole('button', { name: title }).or(page.getByText(title, { exact: true }));
  if (await card.count() === 0) {
    return 'failed';
  }
  await card.first().click();
  return 'opened';
}

/** Click Talk and select a dialogue option if a picker is shown. */
export async function talkQuest(
  page: Page,
  dialogueOption?: string,
): Promise<QuestStepResult> {
  const talkBtn = page.getByRole('button', { name: 'Talk', exact: true });
  if (await talkBtn.count() === 0) {
    return 'no_action';
  }
  await talkBtn.click();

  if (dialogueOption) {
    const option = page.getByRole('button', { name: dialogueOption, exact: true })
      .or(page.getByText(dialogueOption, { exact: true }));
    if (await option.count() > 0) {
      await option.first().click();
      return 'talked';
    }
  }

  // Default dialogue for Wood for the Hearth
  const defaultLine = page.getByText("Right. I'll fetch the logs.", { exact: true });
  if (await defaultLine.count() > 0) {
    await defaultLine.click();
    return 'talked';
  }

  return 'talked';
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
