#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { launchBrowser } from './browser.js';
import {
  readGatherState,
  readSkillState,
  restartGather,
  restartSkillGather,
  getSkillConfig,
  resolveResource,
  type SkillId,
  ensureHuntActive,
  waitForEnemies,
  prepareEnemyBattleSelection,
  readHuntState,
  stopHunt,
  configureAndBattle,
  DETERMINISTIC_MAX_ENEMIES,
  deterministicStance,
  readBattleState,
  runAway,
  huntMore,
  pickBattleEnemy,
  readQuestState,
  openQuest,
  talkQuest,
  turnInQuest,
  isTurnInEnabled,
  readQuestProgress,
  turnInQuestWhenReady,
  buyCheapBait,
} from './deterministic/index.js';
import { createJev } from './jev/index.js';
import { pollUntilHuntStop } from './jev/hunt-cap.js';
import { runAutopilot } from './autopilot.js';
import { readAccountLevels } from './snapshot/account-levels.js';
import {
  attemptHumanVerify,
  isHumanCheckPresent,
} from './deterministic/human-check.js';
import {
  createVerifyBudget,
  effectivePollMs,
  verifyBackoffMs,
} from './deterministic/poll-interval.js';
import type { HuntState } from './types.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const OAK_LOG = 'Oak Log';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SkillLoopOptions {
  buyBait?: boolean;
}

async function runSkillLoop(
  skillId: SkillId,
  resourceLabel: string | undefined,
  verbose: boolean,
  loopOptions: SkillLoopOptions = {},
): Promise<void> {
  const config = loadConfig();
  const buyBait = loopOptions.buyBait ?? config.buyBait;
  const jev = createJev(verbose);
  const skill = getSkillConfig(skillId);
  const resource = resolveResource(skill, resourceLabel);
  const session = await launchBrowser(config);

  console.log(
    `[${skill.id}] Monitoring ${resource} — conservative mode (no interrupt unless Jev allows)`,
  );
  if (skill.requiresBait) {
    console.log(
      buyBait
        ? `[${skill.id}] Fishing requires Cheap Bait — will buy at /merchants if missing (--buy-bait / BUY_BAIT)`
        : `[${skill.id}] Fishing requires Cheap Bait (buy at /merchants → General Goods). Bot does not auto-purchase.`,
    );
  }

  const backoffMs = Math.max(config.pollMs * 6, 30_000);
  let backoffUntil = 0;

  try {
    while (true) {
      const state = await readSkillState(session.page, config, skill.id, {
        probeOtherSkills: true,
      });

      const elsewhere = state.busyElsewhere;
      const elsewhereLabel = elsewhere
        ? `${elsewhere.skill}${elsewhere.resource ? ` (${elsewhere.resource})` : ''}`
        : undefined;

      console.log(
        `[${skill.id}] busy=${state.busy}` +
          `${state.currentResource ? ` resource=${state.currentResource}` : ''}` +
          `${elsewhereLabel ? ` elsewhere=${elsewhereLabel}` : ''}`,
      );

      if (state.busy) {
        backoffUntil = 0;
        await sleep(config.pollMs);
        continue;
      }

      const allowInterrupt = await jev.shouldInterruptGather(state);

      if (elsewhere && !allowInterrupt) {
        if (Date.now() >= backoffUntil) {
          console.log(
            `[${skill.id}] Another action active (${elsewhereLabel}) — waiting (no interrupt)`,
          );
          backoffUntil = Date.now() + backoffMs;
        } else {
          console.log(
            `[${skill.id}] Another action active (${elsewhereLabel}) — backing off`,
          );
        }
        await sleep(config.pollMs);
        continue;
      }

      if (Date.now() < backoffUntil) {
        console.log(`[${skill.id}] Backing off after blocked restart — retry soon`);
        await sleep(config.pollMs);
        continue;
      }
      const result = await restartSkillGather(session.page, config, {
        skill: skill.id,
        resourceLabel: resource,
        allowInterrupt,
        knownState: state,
      });
      console.log(`[${skill.id}] restart → ${result}`);

      if (result === 'missing_requirement') {
        if (skill.requiresBait && buyBait) {
          console.log(`[${skill.id}] Missing Cheap Bait — purchasing 1 at /merchants...`);
          const purchase = await buyCheapBait(session.page, config, 1);
          console.log(`[${skill.id}] buy bait → ${purchase}`);
          if (purchase === 'purchased') {
            await sleep(config.pollMs);
            continue;
          }
        }
        console.error(
          `[${skill.id}] Missing Cheap Bait — buy at /merchants (General Goods, 2g) then retry. Exiting.`,
        );
        break;
      }

      if (result === 'another_action_active' || result === 'kept_current_action') {
        console.log(
          `[${skill.id}] Another gather action is active — backing off ${backoffMs / 1000}s (no interrupt)`,
        );
        backoffUntil = Date.now() + backoffMs;
      }

      await sleep(config.pollMs);
    }
  } finally {
    await session.close();
  }
}

async function runGather(verbose: boolean): Promise<void> {
  await runSkillLoop('woodcutting', OAK_LOG, verbose);
}

interface CombatOptions {
  forceInterrupt?: boolean;
}

async function runCombat(
  verbose: boolean,
  maxRounds = 10,
  combatOptions: CombatOptions = {},
): Promise<void> {
  const config = loadConfig();
  const pollMs = effectivePollMs(config.pollMs);
  const forceInterrupt = combatOptions.forceInterrupt ?? config.forceInterrupt;
  const jev = createJev(verbose);
  const session = await launchBrowser(config);
  const huntBackoffMs = verifyBackoffMs(config.pollMs);

  console.log('[combat] Starting hunt → battle loop');
  console.log(
    forceInterrupt
      ? '[combat] FORCE_INTERRUPT enabled — will click Start anyway on replace dialog'
      : '[combat] Replace dialog: Close keeps gather; Start anyway only when Jev allows interrupt',
  );

  try {
    let rounds = 0;
    while (rounds < maxRounds) {
      rounds++;
      console.log(`[combat] Round ${rounds}/${maxRounds}`);

      const verifyBudget = createVerifyBudget();
      const gatherSnapshot = await readGatherState(session.page, config);
      const allowInterrupt =
        forceInterrupt || (await jev.shouldInterruptGather(gatherSnapshot));

      const preVerify = await attemptHumanVerify(session.page, verifyBudget, pollMs);
      if (preVerify === 'blocked') {
        console.log(`[combat] Verify budget exhausted — backing off ${huntBackoffMs / 1000}s`);
        await sleep(huntBackoffMs);
        continue;
      }

      const huntResult = await ensureHuntActive(
        session.page,
        config,
        allowInterrupt,
        verifyBudget,
      );
      console.log(`[combat] ensureHuntActive → ${huntResult}`);

      if (huntResult === 'no_action') {
        console.log(
          '[combat] Hunt not started — another action is running (replace dialog closed, no interrupt)',
        );
        console.log(`[combat] Backing off ${huntBackoffMs / 1000}s before retry`);
        await sleep(huntBackoffMs);
        continue;
      }

      if (huntResult === 'failed') {
        if (await isHumanCheckPresent(session.page)) {
          console.log(`[combat] Human verify blocking hunt — backing off ${huntBackoffMs / 1000}s`);
          await sleep(huntBackoffMs);
          continue;
        }
        console.log('[combat] ensureHuntActive failed — no Start Hunt, Hunt More, Stop, or enemy cards');
        await sleep(pollMs);
        continue;
      }

      let huntState: HuntState;
      const skipHuntPolling = huntResult === 'enemy_select_ready';

      if (skipHuntPolling) {
        console.log('[combat] Post-hunt enemy selection ready — skipping Stop/poll');
        huntState = await readHuntState(session.page);
      } else {
        const huntStateAfterWait = await waitForEnemies(session.page, 60_000, pollMs);
        if (
          (huntStateAfterWait.totalEnemiesFound ?? 0) === 0 &&
          huntStateAfterWait.enemies.length === 0 &&
          huntStateAfterWait.defeatedCount === 0
        ) {
          console.log('[combat] Hunt active but no hunt metrics yet — polling');
          await sleep(pollMs);
          continue;
        }

        const accountLevels = await readAccountLevels(session.page, config);
        huntState = await pollUntilHuntStop(
          session.page,
          config,
          jev,
          huntStateAfterWait,
          accountLevels,
        );

        console.log(
          `[combat] Hunt metrics: found=${huntState.totalEnemiesFound ?? 0}` +
            ` remaining=${huntState.enemiesRemaining ?? '?'}` +
            ` bonus=${huntState.bonusEnemies ?? '?'}` +
            ` cap-level combat=${accountLevels.combatLevel ?? '?'}`,
        );

        const stopResult = await stopHunt(session.page);
        console.log(`[combat] stopHunt → ${stopResult}`);

        huntState = await prepareEnemyBattleSelection(session.page, 30_000, pollMs);
      }

      if (huntState.enemies.length === 0) {
        console.log('[combat] Could not open enemy detail panel after Stop — waiting');
        await sleep(pollMs);
        continue;
      }

      const enemy = pickBattleEnemy(huntState.enemies);
      if (!enemy) {
        console.log('[combat] No battle target in enemy list — waiting');
        await sleep(pollMs);
        continue;
      }
      console.log(`[combat] Selected enemy: ${enemy.name}`);
      const maxEnemies = DETERMINISTIC_MAX_ENEMIES;
      const stance = deterministicStance(enemy.name);
      const battleResult = await configureAndBattle(
        session.page,
        enemy.index,
        maxEnemies,
        stance,
      );
      console.log(`[combat] battle (${enemy.name}, max=full-stack, stance=${stance}, no Jev) → ${battleResult}`);

      // Monitor battle; flee if Jev says so
      for (let i = 0; i < 60; i++) {
        const battleState = await readBattleState(session.page);
        if (!battleState.inBattle) break;

        if (await jev.shouldFlee(battleState)) {
          const fleeResult = await runAway(session.page);
          console.log(`[combat] flee → ${fleeResult}`);
          break;
        }
        await sleep(pollMs);
      }

      const moreResult = await huntMore(session.page, allowInterrupt);
      console.log(`[combat] huntMore → ${moreResult}`);
      await sleep(pollMs);
    }
  } finally {
    await session.close();
  }
}

async function runQuestTurnIn(questTitle: string, progressItem?: string): Promise<void> {
  const config = loadConfig();
  const session = await launchBrowser(config);

  console.log(`[quest-turnin] Checking "${questTitle}" on Accepted tab`);

  try {
    const outcome = await turnInQuestWhenReady(session.page, config, {
      title: questTitle,
      tab: 'Accepted',
      progressItem,
    });

    if (outcome.progress) {
      console.log(`[quest-turnin] Progress: ${outcome.progress}`);
    }

    switch (outcome.result) {
      case 'turned_in':
        console.log(`[quest-turnin] Turned in "${questTitle}"`);
        break;
      case 'in_progress':
        console.log(`[quest-turnin] Turn In not enabled — quest incomplete or requirements not met`);
        break;
      case 'failed':
        console.error(`[quest-turnin] Could not open quest "${questTitle}"`);
        break;
      default:
        console.log(`[quest-turnin] Result: ${outcome.result}`);
    }
  } finally {
    await session.close();
  }
}

async function runQuest(verbose: boolean): Promise<void> {
  const config = loadConfig();
  const jev = createJev(verbose);
  const session = await launchBrowser(config);

  console.log('[quest] Progressing accepted quests');

  try {
    const state = await readQuestState(session.page, config);
    const priority = await jev.pickQuestPriority(state.quests);

    if (priority.length === 0) {
      console.log('[quest] No quests found on page');
      return;
    }

    for (const title of priority) {
      console.log(`[quest] Working on: ${title}`);

      await openQuest(session.page, config, title);
      await talkQuest(session.page);

      const progress = await readQuestProgress(session.page, OAK_LOG);
      if (progress) {
        console.log(`[quest] Progress: ${progress}`);
      }

      if (await isTurnInEnabled(session.page)) {
        const result = await turnInQuest(session.page);
        console.log(`[quest] turnIn → ${result}`);
      } else {
        console.log('[quest] Turn In not yet enabled — in progress');
      }
    }
  } finally {
    await session.close();
  }
}

async function runFarmHearth(verbose: boolean): Promise<void> {
  const config = loadConfig();
  const jev = createJev(verbose);
  const session = await launchBrowser(config);

  console.log(`[farm-hearth] Gathering ${OAK_LOG} until "${HEARTH_QUEST}" can turn in`);

  try {
    // Accept quest if needed
    await openQuest(session.page, config, HEARTH_QUEST);
    await talkQuest(session.page, "Right. I'll fetch the logs.");

    while (true) {
      // Re-open quest detail after gather navigates to woodcutting
      await openQuest(session.page, config, HEARTH_QUEST);

      if (await isTurnInEnabled(session.page)) {
        console.log('[farm-hearth] Quest complete — turning in');
        const result = await turnInQuest(session.page);
        console.log(`[farm-hearth] turnIn → ${result}`);
        break;
      }

      const progress = await readQuestProgress(session.page, OAK_LOG);
      if (progress) {
        console.log(`[farm-hearth] Progress: ${progress}`);
      }

      const gatherState = await readGatherState(session.page, config);
      if (!gatherState.busy) {
        const allowInterrupt = await jev.shouldInterruptGather(gatherState);
        const result = await restartGather(session.page, config, {
          resourceLabel: OAK_LOG,
          allowInterrupt,
        });
        console.log(`[farm-hearth] gather restart → ${result}`);
      } else {
        console.log('[farm-hearth] Gathering in progress — polling');
      }

      await sleep(config.pollMs);
    }
  } finally {
    await session.close();
  }
}

const program = new Command();

program
  .name('idle-mmo-bot')
  .description('Idle MMO web automation (Playwright + Jev advisor hooks)')
  .option('-v, --verbose', 'Log every Jev decision (wraps HttpJev or StubJev)', false);

program
  .command('gather')
  .description('Poll woodcutting idle/busy; restart Oak Log when idle (alias for skill woodcutting)')
  .action(async (_opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runGather(verbose);
  });

program
  .command('skill')
  .description('Poll a skill page; restart resource when idle')
  .requiredOption(
    '-s, --skill <skill>',
    'Skill: woodcutting, mining, fishing, alchemy, smelting, cooking, forge, construction',
  )
  .option('-r, --resource <name>', 'Resource label (required for crafting skills without defaults)')
  .option('--buy-bait', 'Buy Cheap Bait at merchant when fishing (also BUY_BAIT env)', false)
  .action(async (opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runSkillLoop(opts.skill as SkillId, opts.resource, verbose, {
      buyBait: opts.buyBait,
    });
  });

program
  .command('combat')
  .description('Hunt → battle loop with Jev decision points')
  .option('-r, --rounds <n>', 'Max hunt rounds', '10')
  .option(
    '--interrupt',
    'Click Start anyway on replace dialog (also FORCE_INTERRUPT env)',
    false,
  )
  .action(async (opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runCombat(verbose, Number.parseInt(opts.rounds, 10), {
      forceInterrupt: opts.interrupt,
    });
  });

program
  .command('quest')
  .description('Progress accepted quests; Turn In only when enabled')
  .action(async (_opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runQuest(verbose);
  });

program
  .command('quest-turnin')
  .description('Turn in a quest when Turn In is enabled (default: Wood for the Hearth)')
  .option('-q, --quest <title>', 'Quest title', HEARTH_QUEST)
  .option('-i, --item <name>', 'Progress item to read from Overview', OAK_LOG)
  .action(async (opts) => {
    await runQuestTurnIn(opts.quest, opts.item);
  });

program
  .command('farm-hearth')
  .description('Gather Oak Logs until Wood for the Hearth can turn in')
  .action(async (_opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runFarmHearth(verbose);
  });

program
  .command('autopilot')
  .description('Forever loop: quest → combat → gather → sell junk (overnight mode)')
  .option(
    '--interrupt',
    'Click Start anyway on replace dialog (also FORCE_INTERRUPT env)',
    false,
  )
  .action(async (opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runAutopilot({ verbose, forceInterrupt: opts.interrupt });
  });

program.parse();
