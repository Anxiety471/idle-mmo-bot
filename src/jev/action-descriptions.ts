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
  if (!playbook || playbook.complete || !playbook.enabled) return base;

  const preferred = new Set(playbook.preferredActions);
  const interrupt = new Set(playbook.interruptActions);
  const out: Record<string, string> = {};
  for (const [id, desc] of Object.entries(base)) {
    if (interrupt.has(id) && playbook.stage === 'fish_cod' && id === 'fish_cod') {
      out[id] =
        `[PLAYBOOK FORCE INTERRUPT — fish_cod] ${desc}. ${playbook.stageGoal}. ` +
        `Current gather is not Cod — choose fish_cod now. Do not buy_bait when baitOwned=${playbook.baitOwned}.`;
    } else if (preferred.has(id)) {
      out[id] = `[PLAYBOOK PREFERRED — ${playbook.stage}] ${desc}. ${playbook.stageGoal}`;
    } else if (playbook.deprioritizedActions.includes(id)) {
      out[id] = `[PLAYBOOK LOW PRIORITY] ${desc}`;
    } else {
      out[id] = desc;
    }
  }
  return out;
}
