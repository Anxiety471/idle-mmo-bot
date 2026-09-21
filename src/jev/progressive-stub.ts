import type {
  AutopilotAction,
  AutopilotContext,
  BattleState,
  EnemyInfo,
  GameSnapshot,
  GatherState,
  HuntState,
  QuestInfo,
  Stance,
} from '../types.js';
import type { SupervisorAdvisor } from './supervisor-advisor.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const GOBLIN_QUEST = 'Goblin Menace';
const LOW_HP_THRESHOLD = 25;
const KILL_QUEST_PATTERN = /goblin|duck|rabbit|menace|fortune|whisper/i;

const GATHER_ROTATION: AutopilotAction[] = [
  'gather_oak',
  'mine_coal',
  'fish_cod',
  'gather_yew',
];

function pickAllowed(
  allowed: AutopilotAction[],
  preferred: AutopilotAction[],
): AutopilotAction | undefined {
  for (const action of preferred) {
    if (allowed.includes(action)) return action;
  }
  return undefined;
}

function hasKillQuest(snapshot: GameSnapshot): boolean {
  return [...snapshot.acceptedQuests, ...snapshot.pendingQuests].some(
    (q) => KILL_QUEST_PATTERN.test(q.title) && !q.canTurnIn,
  );
}

function combatLagging(snapshot: GameSnapshot): boolean {
  const total = snapshot.totalLevel ?? 10;
  const combat = snapshot.combatLevel ?? 1;
  return combat < Math.max(3, total * 0.2);
}

/**
 * ProgressiveStubJev — heuristic supervisor for advancing the account without an API token.
 */
export class ProgressiveStubJev implements SupervisorAdvisor {
  async chooseNextAction(
    snapshot: GameSnapshot,
    allowed: AutopilotAction[],
    context: AutopilotContext,
  ): Promise<AutopilotAction> {
    if (!snapshot.flags.sessionValid) {
      return 'idle';
    }

    const turnIn = pickAllowed(allowed, ['quest_turnin']);
    if (turnIn && snapshot.acceptedQuests.some((q) => q.canTurnIn)) {
      return turnIn;
    }

    const continueCurrent = pickAllowed(allowed, ['continue_current']);
    if (continueCurrent && snapshot.currentAction?.busy) {
      return continueCurrent;
    }

    const hunt = pickAllowed(allowed, ['hunt_battle']);
    if (hunt && (hasKillQuest(snapshot) || combatLagging(snapshot))) {
      return hunt;
    }

    const accept = pickAllowed(allowed, ['quest_talk_accept']);
    if (accept && snapshot.pendingQuests.length > 0) {
      const goblin = snapshot.pendingQuests.find((q) => q.title.includes('Goblin'));
      if (goblin || snapshot.pendingQuests.length > 0) return accept;
    }

    const bait = pickAllowed(allowed, ['buy_bait']);
    if (bait && !snapshot.flags.hasBait && (snapshot.gold ?? 0) >= 2) {
      return bait;
    }

    const craft = pickAllowed(allowed, ['craft_if_ready']);
    if (craft && (snapshot.inventory['Coal Ore'] ?? 0) >= 5) {
      return craft;
    }

    const gatherCandidates = GATHER_ROTATION.filter((a) => allowed.includes(a));
    if (gatherCandidates.length > 0 && !snapshot.flags.gatherBusy) {
      return gatherCandidates[context.gatherRotationIndex % gatherCandidates.length];
    }

    const sell = pickAllowed(allowed, ['sell_junk']);
    if (sell && ((snapshot.gold ?? 999) < 100 || Object.keys(snapshot.inventory).length >= 15)) {
      return sell;
    }

    const hearthGather = pickAllowed(allowed, ['gather_oak']);
    if (hearthGather) {
      const hearth = snapshot.acceptedQuests.find((q) => q.title.includes(HEARTH_QUEST));
      if (hearth && !hearth.canTurnIn) return hearthGather;
    }

    return allowed.includes('idle') ? 'idle' : allowed[0];
  }

  async shouldInterruptGather(state: GatherState): Promise<boolean> {
    if (!state.busy && state.busyElsewhere) {
      return KILL_QUEST_PATTERN.test(state.pageText);
    }
    return false;
  }

  async decideHuntStop(state: HuntState): Promise<boolean> {
    return (state.totalEnemiesFound ?? 0) >= 1;
  }

  async chooseStance(enemy: EnemyInfo): Promise<Stance> {
    if (/goblin|rabbit|duck/i.test(enemy.name)) return 'Offensive';
    return 'Balanced';
  }

  async chooseMaxEnemies(_enemy: EnemyInfo): Promise<number> {
    return 1;
  }

  async shouldFlee(battleState: BattleState): Promise<boolean> {
    if (battleState.playerHpPercent === undefined) return false;
    return battleState.playerHpPercent < LOW_HP_THRESHOLD;
  }

  async pickQuestPriority(quests: QuestInfo[]): Promise<string[]> {
    const goblin = quests.find((q) => q.title.includes(GOBLIN_QUEST));
    if (goblin) {
      return [goblin.title, ...quests.filter((q) => q !== goblin).map((q) => q.title)];
    }
    const hearth = quests.find((q) => q.title.includes(HEARTH_QUEST));
    if (hearth) {
      return [hearth.title, ...quests.filter((q) => q !== hearth).map((q) => q.title)];
    }
    return quests.map((q) => q.title);
  }
}
