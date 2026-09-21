import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { HuntState } from '../types.js';
import { navigateTo } from '../browser.js';
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
  talkQuest,
  turnInQuest,
  isTurnInEnabled,
  switchQuestTab,
  waitForQuestTabsSettled,
  buyCheapBait,
  sellJunkToVendor,
  sellHalfCareful,
  trySmeltCoal,
} from '../deterministic/index.js';
import type { ActionAllowContext, ActionDefinition, ActionExecuteContext } from './action-types.js';
import { registerAction } from './action-registry.js';
import { tryCookCod } from '../deterministic/cook.js';
import { getPlaybookFromSnapshot } from './early-systems-playbook.js';
import { shouldHardStopHunt, huntFoundCap } from '../deterministic/hunt-cap.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const GOBLIN_QUEST = 'Goblin Menace';
const KILL_QUEST_PATTERN = /goblin|duck|rabbit|menace|fortune|whisper/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasKillQuest(ctx: ActionAllowContext): boolean {
  const { snapshot } = ctx;
  return [...snapshot.acceptedQuests, ...snapshot.pendingQuests].some(
    (q) => KILL_QUEST_PATTERN.test(q.title) && !q.canTurnIn,
  );
}

function hasTurnInReady(ctx: ActionAllowContext): boolean {
  return ctx.snapshot.acceptedQuests.some((q) => q.canTurnIn);
}

function inventoryPressure(ctx: ActionAllowContext): boolean {
  const total = Object.values(ctx.snapshot.inventory).reduce((s, n) => s + n, 0);
  return total >= 40 || (ctx.snapshot.gold ?? 999) < 50;
}

function hasJunk(ctx: ActionAllowContext): boolean {
  return ctx.junkItems.some((item) => (ctx.snapshot.inventory[item] ?? 0) > 0);
}

function gatherIdle(ctx: ActionAllowContext): boolean {
  return !ctx.snapshot.flags.gatherBusy && !ctx.snapshot.flags.inBattle;
}

async function runCombatRound(ctx: ActionExecuteContext): Promise<string> {
  const { page, config, jev, forceInterrupt } = ctx;
  const huntBackoffMs = Math.max(config.pollMs * 6, 30_000);
  const gatherSnapshot = await readGatherState(page, config);
  const allowInterrupt = forceInterrupt || (await jev.shouldInterruptGather(gatherSnapshot));
  const huntResult = await ensureHuntActive(page, config, allowInterrupt);

  if (huntResult === 'no_action') {
    await sleep(huntBackoffMs);
    return `blocked:${huntResult}`;
  }
  if (huntResult === 'failed') return `failed:${huntResult}`;

  let huntState: HuntState;
  if (huntResult === 'enemy_select_ready') {
    huntState = await readHuntState(page);
  } else {
    const afterWait = await waitForEnemies(page);
    if (
      (afterWait.totalEnemiesFound ?? 0) === 0 &&
      afterWait.enemies.length === 0 &&
      afterWait.defeatedCount === 0
    ) {
      return 'hunt_metrics_pending';
    }
    huntState = afterWait;
    const combatLevel = ctx.snapshot.combatLevel;
    const totalLevel = ctx.snapshot.totalLevel;
    const foundCap = huntFoundCap(combatLevel, totalLevel);
    while (true) {
      const found = huntState.totalEnemiesFound ?? 0;
      if (shouldHardStopHunt(found, combatLevel, totalLevel)) {
        console.log(
          `[combat] Hard stop hunt: found=${found} >= cap=${foundCap}` +
            ` (combat=${combatLevel ?? '?'}, total=${totalLevel ?? '?'})`,
        );
        break;
      }
      if (await jev.decideHuntStop(huntState)) break;
      await sleep(config.pollMs);
      huntState = await readHuntState(page);
    }
    const stopResult = await stopHunt(page);
    huntState = await prepareEnemyBattleSelection(page);
    if (huntState.enemies.length === 0) return `stop:${stopResult}:no_enemies`;
  }

  const enemy = huntState.enemies[0];
  const maxEnemies = await jev.chooseMaxEnemies(enemy);
  const stance = await jev.chooseStance(enemy);
  const battleResult = await configureAndBattle(page, enemy.index, maxEnemies, stance);

  for (let i = 0; i < 60; i++) {
    const battleState = await readBattleState(page);
    if (!battleState.inBattle) break;
    if (await jev.shouldFlee(battleState)) {
      return `battle:${battleResult}:flee:${await runAway(page)}`;
    }
    await sleep(config.pollMs);
  }

  return `battle:${battleResult}:huntMore:${await huntMore(page, allowInterrupt)}`;
}

async function questTurnIn(page: Page, config: AppConfig): Promise<string> {
  const hearth = await turnInQuestWhenReady(page, config, {
    title: HEARTH_QUEST,
    tab: 'Accepted',
    progressItem: 'Oak Log',
  });
  if (hearth.result === 'turned_in') return `turned_in:${HEARTH_QUEST}`;

  await navigateTo(page, config, '/quests');
  await waitForQuestTabsSettled(page);
  await switchQuestTab(page, 'Accepted');

  const cards = page.getByRole('button');
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const label = (await cards.nth(i).innerText()).trim();
    if (label.length < 4 || label === 'Turn In') continue;
    await cards.nth(i).click();
    if (await isTurnInEnabled(page)) {
      return `turned_in:${label}:${await turnInQuest(page)}`;
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
  return `talk:${await talkQuest(page)}`;
}

function gatherAction(
  id: string,
  description: string,
  skill: 'woodcutting' | 'mining' | 'fishing',
  resource: string,
  priority: number,
  extraAllowed?: (ctx: ActionAllowContext) => boolean,
): ActionDefinition {
  return {
    id,
    description,
    bootstrap: true,
    priority,
    tags: ['gather', skill],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const playbookWantsInterrupt =
        Boolean(playbook?.enabled && !playbook.complete && playbook.interruptActions.includes(id));
      const idleOrInterrupt = gatherIdle(ctx) || playbookWantsInterrupt;
      return (
        ctx.snapshot.flags.sessionValid &&
        idleOrInterrupt &&
        (id !== 'fish_cod' || ctx.snapshot.flags.hasBait) &&
        (extraAllowed?.(ctx) ?? true)
      );
    },
    execute: async (ctx) => {
      const gatherState = await readGatherState(ctx.page, ctx.config);
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const playbookInterrupt = Boolean(
        playbook?.enabled && !playbook.complete && playbook.interruptActions.includes(id),
      );
      const allowInterrupt =
        playbookInterrupt || (await ctx.jev.shouldInterruptGather(gatherState));
      const result = await restartSkillGather(ctx.page, ctx.config, {
        skill,
        resourceLabel: resource,
        allowInterrupt: ctx.forceInterrupt || allowInterrupt,
      });
      return { action: id, outcome: result };
    },
  };
}

const BOOTSTRAP_ACTIONS: ActionDefinition[] = [
  {
    id: 'idle',
    description: 'Wait and backoff when no productive action is clear or session invalid',
    bootstrap: true,
    priority: 100,
    tags: ['meta'],
    safety: 'safe',
    isAllowed: () => true,
    execute: async (ctx) => ({
      action: 'idle',
      outcome: 'backoff',
      backoffMs: Math.max(ctx.config.pollMs * 2, 10_000),
    }),
  },
  {
    id: 'continue_current',
    description: 'Keep the current gather, craft, hunt, or battle running',
    bootstrap: true,
    priority: 5,
    tags: ['meta'],
    safety: 'safe',
    isAllowed: (ctx) =>
      Boolean(
        ctx.snapshot.currentAction?.busy ||
          ctx.snapshot.flags.inBattle ||
          ctx.snapshot.combatPhase !== 'none',
      ),
    execute: async (ctx) => ({
      action: 'continue_current',
      outcome: 'polling',
      backoffMs: ctx.config.pollMs,
    }),
  },
  {
    id: 'quest_turnin',
    description: 'Turn in an accepted quest that is complete',
    bootstrap: true,
    priority: 1,
    tags: ['quest'],
    safety: 'safe',
    isAllowed: (ctx) => ctx.snapshot.flags.sessionValid && hasTurnInReady(ctx),
    execute: async (ctx) => ({
      action: 'quest_turnin',
      outcome: await questTurnIn(ctx.page, ctx.config),
    }),
  },
  {
    id: 'quest_talk_accept',
    description: 'Talk to NPC and accept a pending nearby quest',
    bootstrap: true,
    priority: 15,
    tags: ['quest'],
    safety: 'safe',
    isAllowed: (ctx) => ctx.snapshot.flags.sessionValid && ctx.snapshot.pendingQuests.length > 0,
    execute: async (ctx) => ({
      action: 'quest_talk_accept',
      outcome: await questTalkAccept(ctx.page, ctx.config),
    }),
  },
  {
    id: 'hunt_battle',
    description: 'Run combat hunt → stop → battle for kill quests and combat XP',
    bootstrap: true,
    priority: 10,
    tags: ['combat'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const combatLagging =
        (ctx.snapshot.combatLevel ?? 1) <
        Math.max(5, (ctx.snapshot.totalLevel ?? 10) * 0.2);
      return ctx.snapshot.flags.sessionValid && (hasKillQuest(ctx) || combatLagging);
    },
    execute: async (ctx) => ({
      action: 'hunt_battle',
      outcome: await runCombatRound(ctx),
    }),
  },
  gatherAction('gather_oak', 'Woodcut Oak Logs for quest mats and woodcutting XP', 'woodcutting', 'Oak Log', 25),
  gatherAction('gather_yew', 'Woodcut Yew Logs for higher woodcutting XP', 'woodcutting', 'Yew Log', 35),
  gatherAction('mine_coal', 'Mine Coal Ore for smithing mats and combat stats', 'mining', 'Coal Ore', 30),
  gatherAction('fish_cod', 'Fish Cod for food and fishing XP (needs bait)', 'fishing', 'Cod', 32),
  {
    id: 'buy_bait',
    description: 'Buy Cheap Bait at merchants (in-game gold only, 2g)',
    bootstrap: true,
    priority: 20,
    tags: ['economy', 'fishing'],
    safety: 'gold_spend',
    isAllowed: (ctx) => {
      const combatLagging =
        (ctx.snapshot.combatLevel ?? 1) <
        Math.max(5, (ctx.snapshot.totalLevel ?? 10) * 0.2);
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const playbookWantsBait =
        Boolean(playbook?.enabled && !playbook.complete && playbook.stage === 'buy_bait');
      return (
        ctx.snapshot.flags.sessionValid &&
        !ctx.snapshot.flags.hasBait &&
        (ctx.snapshot.gold ?? 0) >= 2 &&
        (ctx.config.buyBait || hasKillQuest(ctx) || combatLagging || playbookWantsBait)
      );
    },
    execute: async (ctx) => ({
      action: 'buy_bait',
      outcome: await buyCheapBait(ctx.page, ctx.config, 1),
    }),
  },
  {
    id: 'cook_cod',
    description: 'Cook Cod into Cooked Cod for battle food (effective HP heal)',
    bootstrap: true,
    priority: 18,
    tags: ['craft', 'combat', 'food'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const inv = ctx.snapshot.inventory;
      const hasCod = (inv['Cod'] ?? 0) >= 1 || (inv['Raw Cod'] ?? 0) >= 1;
      const hasCoal = (inv['Coal Ore'] ?? 0) >= 1;
      const needsFood =
        (inv['Cooked Cod'] ?? 0) < 5 &&
        (inv['Cooked Salmon'] ?? 0) < 5 &&
        (inv['Cooked Tuna'] ?? 0) < 5;
      return (
        ctx.snapshot.flags.sessionValid &&
        gatherIdle(ctx) &&
        hasCod &&
        hasCoal &&
        needsFood
      );
    },
    execute: async (ctx) => {
      const gatherState = await readGatherState(ctx.page, ctx.config);
      const allowInterrupt =
        ctx.forceInterrupt || (await ctx.jev.shouldInterruptGather(gatherState));
      return {
        action: 'cook_cod',
        outcome: await tryCookCod(ctx.page, ctx.config, allowInterrupt),
      };
    },
  },
  {
    id: 'craft_if_ready',
    description: 'Smelt when Coal Ore is available and Start is enabled',
    bootstrap: true,
    priority: 22,
    tags: ['craft'],
    safety: 'safe',
    isAllowed: (ctx) =>
      ctx.snapshot.flags.sessionValid && (ctx.snapshot.inventory['Coal Ore'] ?? 0) >= 1,
    execute: async (ctx) => {
      const gatherState = await readGatherState(ctx.page, ctx.config);
      const allowInterrupt =
        ctx.forceInterrupt || (await ctx.jev.shouldInterruptGather(gatherState));
      return {
        action: 'craft_if_ready',
        outcome: await trySmeltCoal(ctx.page, ctx.config, allowInterrupt),
      };
    },
  },
  {
    id: 'sell_junk',
    description: 'Sell configured vendor-trash items (never quest mats)',
    bootstrap: true,
    priority: 40,
    tags: ['economy'],
    safety: 'inventory',
    isAllowed: (ctx) =>
      ctx.snapshot.flags.sessionValid && (hasJunk(ctx) || inventoryPressure(ctx)),
    execute: async (ctx) => ({
      action: 'sell_junk',
      outcome: await sellJunkToVendor(ctx.page, ctx.config, ctx.junkItems),
    }),
  },

  {
    id: 'market_sell_half',
    description:
      'Careful early-playbook sell: small vendor batches of excess mats; keep Coal for cook and Cod/Cooked Cod for battles (market price reader TBD)',
    bootstrap: true,
    priority: 28,
    tags: ['economy', 'playbook'],
    safety: 'inventory',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const stageOk =
        !playbook ||
        playbook.complete ||
        playbook.stage === 'sell_half' ||
        playbook.stage === 'sell_extras';
      return ctx.snapshot.flags.sessionValid && stageOk;
    },
    execute: async (ctx) => ({
      action: 'market_sell_half',
      outcome: await sellHalfCareful(ctx.page, ctx.config, {
        keepCoal: 15,
        maxStacks: 2,
      }),
    }),
  },
  {
    id: 'hunt_rabbits',
    description:
      'Hunt and battle Rabbits using pre-battle Cooked Cod (FOOD Add). Respects huntFoundCap.',
    bootstrap: true,
    priority: 12,
    tags: ['combat', 'playbook'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const stageOk =
        !playbook ||
        playbook.complete ||
        playbook.stage === 'hunt_rabbits' ||
        playbook.stage === 'complete';
      return ctx.snapshot.flags.sessionValid && stageOk;
    },
    execute: async (ctx) => ({
      action: 'hunt_rabbits',
      outcome: await runCombatRound(ctx),
    }),
  },
];

/** Exploration action — not bootstrap; extends progressive loops as zones unlock. */
const EXPLORATION_ACTIONS: ActionDefinition[] = [
  {
    id: 'explore_map',
    description: 'Open the map modal and read zone/location data (read-only exploration)',
    bootstrap: false,
    priority: 90,
    tags: ['exploration'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      if (playbook?.enabled && !playbook.complete && playbook.stage !== 'explore_map' && playbook.stage !== 'complete') {
        // Still allowed but deprioritized via playbook filter; keep available for Jev.
      }
      return ctx.snapshot.flags.sessionValid;
    },
    execute: async (ctx) => {
      const mapBtn = ctx.page.getByRole('button', { name: /show-map|map/i });
      if (await mapBtn.count() > 0) {
        await mapBtn.first().click({ timeout: 3000 }).catch(() => undefined);
      }
      const text = await ctx.page.locator('body').innerText();
      const zones = text.match(/Bluebell Hollow|The Citadel|[A-Z][a-z]+ Hollow/g) ?? [];
      return {
        action: 'explore_map',
        outcome: `zones:${zones.slice(0, 5).join(',') || 'none'}`,
        backoffMs: ctx.config.pollMs,
      };
    },
  },
];

/** Register bootstrap + built-in exploration actions. Call registerDiscoveredAction() to extend. */
export function registerBootstrapActions(): void {
  for (const def of [...BOOTSTRAP_ACTIONS, ...EXPLORATION_ACTIONS]) {
    registerAction(def);
  }
}

/** Hook for overseer / future modules to register newly scriptable loops at runtime. */
export function registerDiscoveredAction(def: ActionDefinition): void {
  registerAction({ ...def, bootstrap: false });
}
