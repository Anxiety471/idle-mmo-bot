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
import {
  EARLY_GOLD_SELL_ACTIONS,
  getPlaybookFromSnapshot,
} from '../autopilot/early-systems-playbook.js';
import { evaluateQuestCurriculum } from '../autopilot/quest-curriculum.js';
import { parseSellGoldThreshold } from '../deterministic/sell-junk-for-gold.js';
import { hasEasyCompletePendingQuest } from '../deterministic/quest-accept.js';

const HEARTH_QUEST = 'Wood for the Hearth';
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
/** Fight the full hunted stack (UI Max). Not a 1–5 HttpJev score. */
export const DETERMINISTIC_MAX_ENEMIES = Number.MAX_SAFE_INTEGER;

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
    const questCurriculum =
      playbook?.questCurriculum ?? evaluateQuestCurriculum(snapshot);

    if (questCurriculum.hasEasyFinishableQuest) {
      const turnIn = pickAllowed(allowed, ['quest_turnin']);
      if (turnIn) return turnIn;
      const questPreferred = pickAllowed(allowed, questCurriculum.preferredActions);
      if (questPreferred) return questPreferred;
    }

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
      if (playbook.stage === 'fish_cod' && playbook.fishCodBackoffActive) {
        const fallback = pickAllowed(allowed, [
          'continue_current',
          'cook_cod',
          'mine_coal',
          'sell_junk_for_gold',
          'idle',
        ]);
        if (fallback) return fallback;
      }
      if (playbook.stage === 'fish_cod' && !onCod) {
        if (questCurriculum.hasEasyFinishableQuest) {
          const questGather = pickAllowed(
            allowed,
            questCurriculum.preferredActions.filter((a) => a.startsWith('gather_')),
          );
          if (questGather) return questGather;
        }
        // Prefer fishing; only buy_bait when bait is not trusted.
        const prefer = snapshot.flags.hasBait || playbook.baitOwned
          ? (['fish_cod'] as AutopilotAction[])
          : (['fish_cod', 'buy_bait'] as AutopilotAction[]);
        const fish = pickAllowed(allowed, prefer);
        if (fish) return fish;
      }
      const turnIn = pickAllowed(allowed, ['quest_turnin']);
      if (turnIn) return turnIn;
      if (preferredHit && EARLY_GOLD_SELL_ACTIONS.includes(preferredHit)) {
        const accept = pickAllowed(allowed, ['quest_talk_accept']);
        if (accept) return accept;
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
      if (
        def.id === 'quest_talk_accept' &&
        snapshot.pendingQuests.length > 0 &&
        hasEasyCompletePendingQuest(snapshot.pendingQuests)
      ) {
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
        if (questCurriculum.hasEasyFinishableQuest) continue;
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
    // Deterministic early-playbook policy: always Max the ENEMIES stack.
    return DETERMINISTIC_MAX_ENEMIES;
  }

  async shouldFlee(battleState: BattleState): Promise<boolean> {
    if (battleState.playerHpPercent === undefined) return false;
    return battleState.playerHpPercent < LOW_HP_THRESHOLD;
  }

  async pickQuestPriority(quests: QuestInfo[]): Promise<string[]> {
    const snapshotLike = {
      acceptedQuests: quests.filter((q) => !q.isOpen).map((q) => ({
        title: q.title,
        progress: q.progress,
        canTurnIn: q.canTurnIn,
        tab: 'accepted' as const,
      })),
      pendingQuests: quests.filter((q) => q.isOpen).map((q) => ({
        title: q.title,
        progress: q.progress,
        canTurnIn: q.canTurnIn,
        tab: 'pending' as const,
      })),
      inventory: {},
      skillLevels: {},
      location: '',
      pagePath: '',
      combatPhase: 'none' as const,
      flags: {
        hasBait: false,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    };
    const curriculum = evaluateQuestCurriculum(snapshotLike);
    if (curriculum.scoredQuests.length > 0) {
      const ranked = curriculum.scoredQuests.map((q) => q.title);
      const missing = quests.map((q) => q.title).filter((t) => !ranked.includes(t));
      return [...ranked, ...missing];
    }
    return quests.map((q) => q.title);
  }
}
