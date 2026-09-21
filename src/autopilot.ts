import type { Page } from 'playwright';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { launchBrowser } from './browser.js';
import {
  readSkillState,
  restartSkillGather,
  getSkillConfig,
  resolveResource,
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
  readQuestState,
  openQuest,
  talkQuest,
  turnInQuest,
  isTurnInEnabled,
  readQuestProgress,
  turnInQuestWhenReady,
  sellJunk,
  type SkillId,
} from './deterministic/index.js';
import { createJev } from './jev/create-jev.js';
import type { JevAdvisor } from './jev/index.js';
import type { HuntState } from './types.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const OAK_LOG = 'Oak Log';

const PHASES = ['quest', 'combat', 'gather', 'sell'] as const;
type AutopilotPhase = (typeof PHASES)[number];

export interface AutopilotOptions {
  verbose?: boolean;
  forceInterrupt?: boolean;
  gatherSkill?: SkillId;
  gatherResource?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveGatherSkill(): SkillId {
  const raw = process.env.AUTOPILOT_GATHER_SKILL?.trim().toLowerCase();
  if (raw && ['woodcutting', 'mining', 'fishing'].includes(raw)) {
    return raw as SkillId;
  }
  return 'woodcutting';
}

function resolveGatherResource(skillId: SkillId): string {
  const env = process.env.AUTOPILOT_GATHER_RESOURCE?.trim();
  const skill = getSkillConfig(skillId);
  return resolveResource(skill, env || undefined);
}

async function questTick(
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
): Promise<void> {
  const hearth = await turnInQuestWhenReady(page, config, {
    title: HEARTH_QUEST,
    tab: 'Accepted',
    progressItem: OAK_LOG,
  });
  console.log(`[autopilot:quest] hearth turn-in → ${hearth.result}`);

  const state = await readQuestState(page, config);
  const priority = await jev.pickQuestPriority(state.quests);
  if (priority.length === 0) {
    console.log('[autopilot:quest] keep gathering / no quest priority');
    return;
  }

  const title = priority[0];
  console.log(`[autopilot:quest] working on "${title}"`);
  await openQuest(page, config, title);
  await talkQuest(
    page,
    title.includes('Hearth') ? "Right. I'll fetch the logs." : undefined,
  );

  const progress = await readQuestProgress(page, OAK_LOG);
  if (progress) {
    console.log(`[autopilot:quest] progress: ${progress}`);
  }

  if (await isTurnInEnabled(page)) {
    const result = await turnInQuest(page);
    console.log(`[autopilot:quest] turnIn → ${result}`);
  }
}

async function combatTick(
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
  forceInterrupt: boolean,
): Promise<void> {
  const huntBackoffMs = Math.max(config.pollMs * 6, 30_000);
  const gatherSnapshot = await readGatherState(page, config);
  const allowInterrupt = forceInterrupt || (await jev.shouldInterruptGather(gatherSnapshot));
  const huntResult = await ensureHuntActive(page, config, allowInterrupt);
  console.log(`[autopilot:combat] ensureHuntActive → ${huntResult}`);

  if (huntResult === 'no_action') {
    console.log(`[autopilot:combat] blocked — backing off ${huntBackoffMs / 1000}s`);
    await sleep(huntBackoffMs);
    return;
  }

  if (huntResult === 'failed') {
    console.log('[autopilot:combat] ensureHuntActive failed');
    return;
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
      console.log('[autopilot:combat] hunt metrics not ready yet');
      return;
    }

    huntState = huntStateAfterWait;
    while (!(await jev.decideHuntStop(huntState))) {
      await sleep(config.pollMs);
      huntState = await readHuntState(page);
    }

    const stopResult = await stopHunt(page);
    console.log(`[autopilot:combat] stopHunt → ${stopResult}`);
    huntState = await prepareEnemyBattleSelection(page);
  }

  if (huntState.enemies.length === 0) {
    console.log('[autopilot:combat] no enemy selection ready');
    return;
  }

  const enemy = huntState.enemies[0];
  const maxEnemies = await jev.chooseMaxEnemies(enemy);
  const stance = await jev.chooseStance(enemy);
  const battleResult = await configureAndBattle(page, enemy.index, maxEnemies, stance);
  console.log(
    `[autopilot:combat] battle (${enemy.name}, max=${maxEnemies}, stance=${stance}) → ${battleResult}`,
  );

  for (let i = 0; i < 60; i++) {
    const battleState = await readBattleState(page);
    if (!battleState.inBattle) break;
    if (await jev.shouldFlee(battleState)) {
      const fleeResult = await runAway(page);
      console.log(`[autopilot:combat] flee → ${fleeResult}`);
      break;
    }
    await sleep(config.pollMs);
  }

  const moreResult = await huntMore(page, allowInterrupt);
  console.log(`[autopilot:combat] huntMore → ${moreResult}`);
}

async function gatherTick(
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
  skillId: SkillId,
  resource: string,
): Promise<void> {
  const state = await readSkillState(page, config, skillId, { probeOtherSkills: true });
  console.log(
    `[autopilot:gather] ${skillId} busy=${state.busy}` +
      `${state.currentResource ? ` resource=${state.currentResource}` : ''}` +
      `${state.busyElsewhere ? ` elsewhere=${state.busyElsewhere.skill}` : ''}`,
  );

  if (state.busy) return;

  const allowInterrupt = await jev.shouldInterruptGather(state);
  if (state.busyElsewhere && !allowInterrupt) {
    console.log('[autopilot:gather] another action active — skip restart');
    return;
  }

  const result = await restartSkillGather(page, config, {
    skill: skillId,
    resourceLabel: resource,
    allowInterrupt,
    knownState: state,
  });
  console.log(`[autopilot:gather] restart → ${result}`);
}

async function sellTick(page: Page, config: AppConfig): Promise<void> {
  const result = await sellJunk(page, config);
  console.log(`[autopilot:sell] sellJunk → ${result}`);
}

async function runPhase(
  phase: AutopilotPhase,
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
  options: AutopilotOptions,
  gatherSkill: SkillId,
  gatherResource: string,
): Promise<void> {
  switch (phase) {
    case 'quest':
      await questTick(page, config, jev);
      break;
    case 'combat':
      await combatTick(page, config, jev, options.forceInterrupt ?? config.forceInterrupt);
      break;
    case 'gather':
      await gatherTick(page, config, jev, gatherSkill, gatherResource);
      break;
    case 'sell':
      await sellTick(page, config);
      break;
  }
}

/**
 * Forever autopilot loop: quest → combat → gather → sell junk.
 * Relaunches the browser session on fatal errors for overnight runs.
 */
export async function runAutopilot(options: AutopilotOptions = {}): Promise<void> {
  const config = loadConfig();
  const jev = createJev(options.verbose ?? false);
  const gatherSkill = options.gatherSkill ?? resolveGatherSkill();
  const gatherResource = options.gatherResource ?? resolveGatherResource(gatherSkill);
  const hasJevToken = Boolean(process.env.JEV_API_TOKEN?.trim() || process.env.TYPESAFE_API_KEY?.trim());

  console.log('[autopilot] Starting forever loop');
  console.log(
    `[autopilot] Jev: ${hasJevToken ? 'HttpJev (TypeSafe API)' : 'StubJev (set JEV_API_TOKEN for live advisor)'}`,
  );
  console.log(`[autopilot] Gather: ${gatherSkill} → ${gatherResource}`);
  console.log(`[autopilot] Phases: ${PHASES.join(' → ')} (repeat)`);

  let cycle = 0;
  let phaseIndex = 0;
  const sessionRelaunchMs = Math.max(config.pollMs * 6, 30_000);

  while (true) {
    const session = await launchBrowser(config);
    try {
      while (true) {
        cycle++;
        const phase = PHASES[phaseIndex % PHASES.length];
        phaseIndex++;

        console.log(`[autopilot] —— cycle ${cycle} · ${phase} ——`);
        try {
          await runPhase(phase, session.page, config, jev, options, gatherSkill, gatherResource);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[autopilot] ${phase} tick error: ${message}`);
        }

        await sleep(config.pollMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[autopilot] session error — relaunching in ${sessionRelaunchMs / 1000}s: ${message}`,
      );
      await sleep(sessionRelaunchMs);
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}
