import type { JevAdvisor } from './types.js';
import type {
  BattleState,
  EnemyInfo,
  GatherState,
  HuntState,
  QuestInfo,
  Stance,
} from '../types.js';

function log(method: string, detail: string): void {
  console.log(`[Jev:Console] ${method} → ${detail}`);
}

/**
 * ConsoleJev — logs every decision and returns safe defaults for local testing.
 */
export class ConsoleJev implements JevAdvisor {
  async shouldInterruptGather(state: GatherState): Promise<boolean> {
    log('shouldInterruptGather', `busy=${state.busy} → false (safe default)`);
    return false;
  }

  async decideHuntStop(state: HuntState): Promise<boolean> {
    const stop = (state.totalEnemiesFound ?? 0) >= 1;
    log(
      'decideHuntStop',
      `found=${state.totalEnemiesFound ?? 0}, remaining=${state.enemiesRemaining ?? '?'}, cards=${state.enemies.length} → ${stop}`,
    );
    return stop;
  }

  async chooseStance(enemy: EnemyInfo): Promise<Stance> {
    log('chooseStance', `enemy="${enemy.name}" → Balanced`);
    return 'Balanced';
  }

  async chooseMaxEnemies(enemy: EnemyInfo): Promise<number> {
    log('chooseMaxEnemies', `enemy="${enemy.name}" → 1`);
    return 1;
  }

  async shouldFlee(battleState: BattleState): Promise<boolean> {
    const flee = (battleState.playerHpPercent ?? 100) < 20;
    log('shouldFlee', `hp=${battleState.playerHpPercent ?? '?'}% → ${flee}`);
    return flee;
  }

  async pickQuestPriority(quests: QuestInfo[]): Promise<string[]> {
    const hearth = quests.find((q) => q.title.includes('Wood for the Hearth'));
    const ordered = hearth
      ? [hearth.title, ...quests.filter((q) => q !== hearth).map((q) => q.title)]
      : quests.map((q) => q.title);
    log('pickQuestPriority', ordered.join(', '));
    return ordered;
  }
}
