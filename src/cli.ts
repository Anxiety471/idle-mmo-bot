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
  startHunt,
  waitForEnemies,
  readHuntState,
  stopHunt,
  configureAndBattle,
  readBattleState,
  runAway,
  huntMore,
  readQuestState,
  openQuest,
  talkQuest,
  turnInQuest,
  isTurnInEnabled,
  readQuestProgress,
} from './deterministic/index.js';
import { ConsoleJev, StubJev, type JevAdvisor } from './jev/index.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const OAK_LOG = 'Oak Log';

function createJev(verbose: boolean): JevAdvisor {
  return verbose ? new ConsoleJev() : new StubJev();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSkillLoop(
  skillId: SkillId,
  resourceLabel: string | undefined,
  verbose: boolean,
): Promise<void> {
  const config = loadConfig();
  const jev = createJev(verbose);
  const skill = getSkillConfig(skillId);
  const resource = resolveResource(skill, resourceLabel);
  const session = await launchBrowser(config);

  console.log(
    `[${skill.id}] Monitoring ${resource} — conservative mode (no interrupt unless Jev allows)`,
  );
  if (skill.requiresBait) {
    console.log(
      `[${skill.id}] Fishing requires Cheap Bait (buy at /merchants → General Goods). Bot does not auto-purchase.`,
    );
  }

  try {
    while (true) {
      const state = await readSkillState(session.page, config, skill.id);
      console.log(
        `[${skill.id}] busy=${state.busy}${state.currentResource ? ` resource=${state.currentResource}` : ''}`,
      );

      if (!state.busy) {
        const allowInterrupt = await jev.shouldInterruptGather(state);
        const result = await restartSkillGather(session.page, config, {
          skill: skill.id,
          resourceLabel: resource,
          allowInterrupt,
        });
        console.log(`[${skill.id}] restart → ${result}`);

        if (result === 'missing_requirement') {
          console.error(
            `[${skill.id}] Missing Cheap Bait — buy at /merchants (General Goods, 2g) then retry. Exiting.`,
          );
          break;
        }
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

async function runCombat(verbose: boolean, maxRounds = 10): Promise<void> {
  const config = loadConfig();
  const jev = createJev(verbose);
  const session = await launchBrowser(config);

  console.log('[combat] Starting hunt → battle loop');

  try {
    let rounds = 0;
    while (rounds < maxRounds) {
      rounds++;
      console.log(`[combat] Round ${rounds}/${maxRounds}`);

      const gatherSnapshot = await readGatherState(session.page, config);
      const allowInterrupt = await jev.shouldInterruptGather(gatherSnapshot);
      const huntResult = await startHunt(session.page, config, allowInterrupt);
      console.log(`[combat] startHunt → ${huntResult}`);
      if (huntResult === 'failed' || huntResult === 'no_action') {
        await sleep(config.pollMs);
        continue;
      }

      await waitForEnemies(session.page);

      let huntState = await readHuntState(session.page);
      while (!(await jev.decideHuntStop(huntState))) {
        await sleep(config.pollMs);
        huntState = await readHuntState(session.page);
      }

      const stopResult = await stopHunt(session.page);
      console.log(`[combat] stopHunt → ${stopResult}`);

      if (huntState.enemies.length === 0) {
        console.log('[combat] No enemies visible — waiting');
        await sleep(config.pollMs);
        continue;
      }

      const enemy = huntState.enemies[0];
      const maxEnemies = await jev.chooseMaxEnemies(enemy);
      const stance = await jev.chooseStance(enemy);
      const battleResult = await configureAndBattle(
        session.page,
        enemy.index,
        maxEnemies,
        stance,
      );
      console.log(`[combat] battle (${enemy.name}, max=${maxEnemies}, stance=${stance}) → ${battleResult}`);

      // Monitor battle; flee if Jev says so
      for (let i = 0; i < 60; i++) {
        const battleState = await readBattleState(session.page);
        if (!battleState.inBattle) break;

        if (await jev.shouldFlee(battleState)) {
          const fleeResult = await runAway(session.page);
          console.log(`[combat] flee → ${fleeResult}`);
          break;
        }
        await sleep(config.pollMs);
      }

      const moreResult = await huntMore(session.page);
      console.log(`[combat] huntMore → ${moreResult}`);
      await sleep(config.pollMs);
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
  .option('-v, --verbose', 'Use ConsoleJev (logs decisions) instead of StubJev', false);

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
  .requiredOption('-s, --skill <skill>', 'Skill: woodcutting, mining, or fishing')
  .option('-r, --resource <name>', 'Resource label (defaults per skill)')
  .action(async (opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runSkillLoop(opts.skill as SkillId, opts.resource, verbose);
  });

program
  .command('combat')
  .description('Hunt → battle loop with Jev decision points')
  .option('-r, --rounds <n>', 'Max hunt rounds', '10')
  .action(async (opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runCombat(verbose, Number.parseInt(opts.rounds, 10));
  });

program
  .command('quest')
  .description('Progress accepted quests; Turn In only when enabled')
  .action(async (_opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runQuest(verbose);
  });

program
  .command('farm-hearth')
  .description('Gather Oak Logs until Wood for the Hearth can turn in')
  .action(async (_opts, cmd) => {
    const verbose = cmd.parent?.opts().verbose ?? false;
    await runFarmHearth(verbose);
  });

program.parse();
