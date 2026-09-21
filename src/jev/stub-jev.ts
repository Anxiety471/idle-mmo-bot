import type { JevAdvisor } from './types.js';
import type {
  BattleState,
  EnemyInfo,
  GatherState,
  HuntState,
  QuestInfo,
  Stance,
} from '../types.js';

const HEARTH_QUEST = 'Wood for the Hearth';
const LOW_HP_THRESHOLD = 25;

/**
 * StubJev — conservative defaults for unattended runs.
 *
 * - Never interrupt an active gather
 * - Stop hunt when Total Enemies Found >= 1 (cards appear only after Stop)
 * - Balanced stance, max 1 enemy
 * - Flee only when HP is detectably low
 * - Prefer "Wood for the Hearth" quest
 */
export class StubJev implements JevAdvisor {
  async shouldInterruptGather(_state: GatherState): Promise<boolean> {
    return false;
  }

  async decideHuntStop(state: HuntState): Promise<boolean> {
    return (state.totalEnemiesFound ?? 0) >= 1;
  }

  async chooseStance(_enemy: EnemyInfo): Promise<Stance> {
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
    const hearth = quests.find((q) => q.title.includes(HEARTH_QUEST));
    if (hearth) {
      return [hearth.title, ...quests.filter((q) => q !== hearth).map((q) => q.title)];
    }
    return quests.map((q) => q.title);
  }
}
