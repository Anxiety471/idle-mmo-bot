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
import { listActions } from '../autopilot/action-registry.js';
import { huntFoundCap } from './hunt-cap.js';
import type { SupervisorAdvisor } from './supervisor-advisor.js';
import { getPlaybookFromSnapshot } from '../autopilot/early-systems-playbook.js';
import { parseSellGoldThreshold } from '../deterministic/sell-junk-for-gold.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const GOBLIN_QUEST = 'Goblin Menace';
const LOW_HP_THRESHOLD = 25;
const KILL_QUEST_PATTERN = /goblin|duck|rabbit|menace|fortune|whisper/i;

function pickAllowed(
  allowed: AutopilotAction[],
  preferred: AutopilotAction[],
): AutopilotAction | undefined {
  for (const action of preferred) {
    if (allowed.includes(action)) return action;
  }
  return undefined;
}

function gatherRotationActions(allowed: AutopilotAction[]): AutopilotAction[] {
  const gatherIds = listActions()
    .filter((a) => a.tags?.includes('gather'))
    .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
    .map((a) => a.id);
  return gatherIds.filter((id) => allowed.includes(id));
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
 * ProgressiveStubJev — heuristic supervisor; uses registry priorities/tags so new actions
 * participate automatically when registered.
 */
export class ProgressiveStubJev implements SupervisorAdvisor {
  async chooseNextAction(
    snapshot: GameSnapshot,
    allowed: AutopilotAction[],
    context: AutopilotContext,
  ): Promise<AutopilotAction> {
    if (!snapshot.flags.sessionValid) {
      return allowed.includes('idle') ? 'idle' : allowed[0];
    }

    const playbook = getPlaybookFromSnapshot(snapshot);
    if (playbook && playbook.enabled && !playbook.complete) {
      if (playbook.stage === 'fish_cod' && playbook.gatherGraceActive) {
        const cont = pickAllowed(allowed, ['continue_current']);
        if (cont) return cont;
      }
      const preferredHit = pickAllowed(allowed, playbook.preferredActions);
      const resource = snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '';
      const onCoal = /coal/i.test(resource);
      const onCod = /\bcod\b/i.test(resource);
      if (playbook.stage === 'mine_coal' && !onCoal) {
        const mine = pickAllowed(allowed, ['mine_coal']);
        if (mine) return mine;
      }
      if (playbook.stage === 'fish_cod' && !onCod) {
        // Prefer fishing; only buy_bait when bait is not trusted.
        const prefer = snapshot.flags.hasBait || playbook.baitOwned
          ? (['fish_cod'] as AutopilotAction[])
          : (['fish_cod', 'buy_bait'] as AutopilotAction[]);
        const fish = pickAllowed(allowed, prefer);
        if (fish) return fish;
      }
      if (preferredHit && preferredHit !== 'continue_current') return preferredHit;
    }

    const byPriority = listActions()
      .filter((a) => allowed.includes(a.id))
      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

    for (const def of byPriority) {
      if (def.id === 'quest_turnin' && snapshot.acceptedQuests.some((q) => q.canTurnIn)) {
        return def.id;
      }
      if (def.id === 'continue_current' && snapshot.currentAction?.busy) {
        // Skip continue when playbook wants a different gather (interrupt path).
        if (playbook && !playbook.complete && playbook.interruptActions.length) {
          const resource = snapshot.currentAction?.resource ?? '';
          if (playbook.stage === 'mine_coal' && !/coal/i.test(resource)) {
            continue;
          }
          if (playbook.stage === 'fish_cod' && !/cod/i.test(resource)) {
            continue;
          }
        }
        return def.id;
      }
      if (def.id === 'hunt_battle' && (hasKillQuest(snapshot) || combatLagging(snapshot))) {
        return def.id;
      }
      if (def.id === 'quest_talk_accept' && snapshot.pendingQuests.length > 0) {
        return def.id;
      }
      if (
        def.id === 'buy_bait' &&
        !snapshot.flags.hasBait &&
        !(playbook?.baitOwned) &&
        playbook?.stage !== 'fish_cod' &&
        playbook?.stage === 'buy_bait' &&
        (snapshot.gold ?? 0) >= 2
      ) {
        return def.id;
      }
      if (def.id === 'craft_if_ready' && (snapshot.inventory['Coal Ore'] ?? 0) >= 5) {
        return def.id;
      }
    }

    const gatherCandidates = gatherRotationActions(allowed);
    if (gatherCandidates.length > 0 && !snapshot.flags.gatherBusy) {
      return gatherCandidates[context.gatherRotationIndex % gatherCandidates.length];
    }

    const sellForGold = pickAllowed(allowed, ['sell_junk_for_gold']);
    if (sellForGold && (snapshot.gold ?? 999) < parseSellGoldThreshold()) {
      return sellForGold;
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
    const cap = huntFoundCap(state.combatLevel, state.totalLevel);
    return (state.totalEnemiesFound ?? 0) >= cap;
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
