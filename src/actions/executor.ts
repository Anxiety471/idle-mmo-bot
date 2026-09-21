import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type {
  ActionResult,
  AutopilotAction,
  HuntState,
} from '../types.js';
import {
  restartSkillGather,
  readGatherState,
  ensureHuntActive,
  waitForEnemies,
  prepareEnemyBattleSelection,
  readHuntState,
  stopHunt,
  configureAndBattle,
  readBattleState,
  runAway,
  huntMore,
  turnInQuestWhenReady,
  openQuest,
  talkQuest,
  turnInQuest,
  isTurnInEnabled,
  switchQuestTab,
  waitForQuestTabsSettled,
  buyCheapBait,
  sellJunkToVendor,
  trySmeltCoal,
} from '../deterministic/index.js';
import { navigateTo } from '../browser.js';
import type { JevAdvisor } from '../jev/types.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const GOBLIN_QUEST = 'Goblin Menace';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GATHER_ACTION_MAP: Partial<
  Record<AutopilotAction, { skill: 'woodcutting' | 'mining' | 'fishing'; resource: string }>
> = {
  gather_oak: { skill: 'woodcutting', resource: 'Oak Log' },
  gather_yew: { skill: 'woodcutting', resource: 'Yew Log' },
  mine_coal: { skill: 'mining', resource: 'Coal Ore' },
  fish_cod: { skill: 'fishing', resource: 'Cod' },
};

async function runCombatRound(
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
  forceInterrupt: boolean,
): Promise<string> {
  const huntBackoffMs = Math.max(config.pollMs * 6, 30_000);
  const gatherSnapshot = await readGatherState(page, config);
  const allowInterrupt = forceInterrupt || (await jev.shouldInterruptGather(gatherSnapshot));
  const huntResult = await ensureHuntActive(page, config, allowInterrupt);

  if (huntResult === 'no_action') {
    await sleep(huntBackoffMs);
    return `blocked:${huntResult}`;
  }
  if (huntResult === 'failed') {
    return `failed:${huntResult}`;
  }

  let huntState: HuntState;
  if (huntResult === 'enemy_select_ready') {
    huntState = await readHuntState(page);
  } else {
    const huntStateAfterWait = await waitForEnemies(page);
    if (
      (huntStateAfterWait.totalEnemiesFound ?? 0) === 0 &&
      huntStateAfterWait.enemies.length === 0 &&
      huntStateAfterWait.defeatedCount === 0
    ) {
      return 'hunt_metrics_pending';
    }

    huntState = huntStateAfterWait;
    while (!(await jev.decideHuntStop(huntState))) {
      await sleep(config.pollMs);
      huntState = await readHuntState(page);
    }

    const stopResult = await stopHunt(page);
    huntState = await prepareEnemyBattleSelection(page);
    if (huntState.enemies.length === 0) {
      return `stop:${stopResult}:no_enemies`;
    }
  }

  const enemy = huntState.enemies[0];
  const maxEnemies = await jev.chooseMaxEnemies(enemy);
  const stance = await jev.chooseStance(enemy);
  const battleResult = await configureAndBattle(page, enemy.index, maxEnemies, stance);

  for (let i = 0; i < 60; i++) {
    const battleState = await readBattleState(page);
    if (!battleState.inBattle) break;
    if (await jev.shouldFlee(battleState)) {
      const fleeResult = await runAway(page);
      return `battle:${battleResult}:flee:${fleeResult}`;
    }
    await sleep(config.pollMs);
  }

  const moreResult = await huntMore(page, allowInterrupt);
  return `battle:${battleResult}:huntMore:${moreResult}`;
}

async function questTurnIn(page: Page, config: AppConfig): Promise<string> {
  const hearth = await turnInQuestWhenReady(page, config, {
    title: HEARTH_QUEST,
    tab: 'Accepted',
    progressItem: 'Oak Log',
  });
  if (hearth.result === 'turned_in') {
    return `turned_in:${HEARTH_QUEST}`;
  }

  await navigateTo(page, config, '/quests');
  await waitForQuestTabsSettled(page);
  await switchQuestTab(page, 'Accepted');

  const turnInBtn = page.getByRole('button', { name: 'Turn In', exact: true });
  if (await turnInBtn.count() > 0 && !(await turnInBtn.first().isDisabled())) {
    const cards = page.getByRole('button');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const label = (await cards.nth(i).innerText()).trim();
      if (label.length < 4 || label === 'Turn In') continue;
      await cards.nth(i).click();
      if (await isTurnInEnabled(page)) {
        const result = await turnInQuest(page);
        return `turned_in:${label}:${result}`;
      }
    }
  }

  return `in_progress:${hearth.result}`;
}

async function questTalkAccept(page: Page, config: AppConfig): Promise<string> {
  await navigateTo(page, config, '/quests');
  await waitForQuestTabsSettled(page);
  await switchQuestTab(page, 'Pending Nearby');

  const preferred = page.getByRole('button', { name: GOBLIN_QUEST });
  if (await preferred.count() > 0) {
    await preferred.first().click();
  } else {
    const cards = page.getByRole('button');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const label = (await cards.nth(i).innerText()).trim();
      if (/Menace|Whisper|Fortune|Hearth/i.test(label)) {
        await cards.nth(i).click();
        break;
      }
    }
  }

  const talkResult = await talkQuest(page);
  return `talk:${talkResult}`;
}

/** Execute one supervisor action deterministically. */
export async function executeAction(
  action: AutopilotAction,
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
  options: { forceInterrupt?: boolean; junkItems?: string[] } = {},
): Promise<ActionResult> {
  const forceInterrupt = options.forceInterrupt ?? config.forceInterrupt;
  const junkItems = options.junkItems ?? [];

  switch (action) {
    case 'continue_current':
      return { action, outcome: 'polling', backoffMs: config.pollMs };

    case 'idle':
      return {
        action,
        outcome: 'backoff',
        backoffMs: Math.max(config.pollMs * 2, 10_000),
      };

    case 'gather_oak':
    case 'gather_yew':
    case 'mine_coal':
    case 'fish_cod': {
      const mapping = GATHER_ACTION_MAP[action];
      if (!mapping) return { action, outcome: 'unknown_gather' };
      const gatherState = await readGatherState(page, config);
      const allowInterrupt = await jev.shouldInterruptGather(gatherState);
      const result = await restartSkillGather(page, config, {
        skill: mapping.skill,
        resourceLabel: mapping.resource,
        allowInterrupt: forceInterrupt || allowInterrupt,
      });
      return { action, outcome: result };
    }

    case 'buy_bait': {
      const result = await buyCheapBait(page, config, 1);
      return { action, outcome: result };
    }

    case 'hunt_battle': {
      const outcome = await runCombatRound(page, config, jev, forceInterrupt);
      return { action, outcome };
    }

    case 'quest_turnin': {
      const outcome = await questTurnIn(page, config);
      return { action, outcome };
    }

    case 'quest_talk_accept': {
      const outcome = await questTalkAccept(page, config);
      return { action, outcome };
    }

    case 'craft_if_ready': {
      const gatherState = await readGatherState(page, config);
      const allowInterrupt = forceInterrupt || (await jev.shouldInterruptGather(gatherState));
      const result = await trySmeltCoal(page, config, allowInterrupt);
      return { action, outcome: result };
    }

    case 'sell_junk': {
      const result = await sellJunkToVendor(page, config, junkItems);
      return { action, outcome: result };
    }

    default:
      return { action, outcome: 'unknown_action', backoffMs: config.pollMs };
  }
}
