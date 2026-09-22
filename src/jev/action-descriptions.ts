import type { AutopilotAction, GameSnapshot } from '../types.js';
import { describeActions } from '../autopilot/action-registry.js';
import { getPlaybookFromSnapshot } from '../autopilot/early-systems-playbook.js';

/** Criteria map for HttpJev choice questions — pulls from registered action definitions + playbook boosts. */
export function actionCriteria(
  allowed: AutopilotAction[],
  snapshot?: GameSnapshot,
): Record<string, string> {
  const base = describeActions(allowed);
  const playbook = snapshot ? getPlaybookFromSnapshot(snapshot) : undefined;
  const questCurriculum = playbook?.questCurriculum;
  if (!playbook || playbook.complete || !playbook.enabled) {
    if (!questCurriculum?.hasEasyFinishableQuest) return base;
  }

  const preferred = new Set(playbook?.preferredActions ?? []);
  const interrupt = new Set(playbook?.interruptActions ?? []);
  const questPreferred = new Set(questCurriculum?.preferredActions ?? []);
  const questDeprioritized = new Set(questCurriculum?.deprioritizedActions ?? []);
  const questInterrupt = new Set(questCurriculum?.interruptActions ?? []);
  const out: Record<string, string> = {};

  for (const [id, desc] of Object.entries(base)) {
    if (id === 'quest_turnin' && snapshot?.acceptedQuests.some((q) => q.canTurnIn)) {
      out[id] =
        `[QUEST TURN-IN READY] ${desc}. Choose quest_turnin before any gather or fish_cod.`;
      continue;
    }
    if (
      questInterrupt.has(id) &&
      snapshot?.currentAction?.busy &&
      !/oak/i.test(snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '')
    ) {
      out[id] =
        `[QUEST FORCE INTERRUPT — ${questCurriculum?.topQuest?.title ?? 'easy quest'}] ${desc}. ` +
        `${questCurriculum?.hint ?? 'Interrupt wrong gather for quest progress.'}`;
      continue;
    }
    if (questPreferred.has(id)) {
      out[id] =
        `[QUEST HIGH PRIORITY — ${questCurriculum?.topQuest?.title ?? 'finishable quest'}] ${desc}. ` +
        `${questCurriculum?.hint ?? 'Prefer this over fish_cod and hard hunts.'}`;
      continue;
    }
    if (questDeprioritized.has(id)) {
      out[id] =
        `[QUEST LOW PRIORITY — easier quest available] ${desc}. ` +
        `${questCurriculum?.hint ?? 'Deprioritize until easy quest completes.'}`;
      continue;
    }
    if (interrupt.has(id) && playbook?.stage === 'fish_cod' && id === 'fish_cod') {
      out[id] =
        `[PLAYBOOK FORCE INTERRUPT — fish_cod] ${desc}. ${playbook.stageGoal}. ` +
        `Current gather is not Cod — choose fish_cod now. Do not buy_bait when baitOwned=${playbook.baitOwned}.`;
    } else if (preferred.has(id)) {
      out[id] = `[PLAYBOOK PREFERRED — ${playbook?.stage}] ${desc}. ${playbook?.stageGoal ?? ''}`;
    } else if (playbook?.deprioritizedActions.includes(id)) {
      out[id] = `[PLAYBOOK LOW PRIORITY] ${desc}`;
    } else {
      out[id] = desc;
    }
  }
  return out;
}
