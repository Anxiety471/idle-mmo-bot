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
import { ProgressiveStubJev } from './progressive-stub.js';
import type { SupervisorAdvisor } from './supervisor-advisor.js';

function log(method: string, detail: string): void {
  console.log(`[Jev:Console] ${method} → ${detail}`);
}

/**
 * ConsoleJev — logs every decision from an inner supervisor advisor.
 */
export class ConsoleJev implements SupervisorAdvisor {
  constructor(private readonly inner: SupervisorAdvisor = new ProgressiveStubJev()) {}

  async chooseNextAction(
    snapshot: GameSnapshot,
    allowed: AutopilotAction[],
    context: AutopilotContext,
  ): Promise<AutopilotAction> {
    const result = await this.inner.chooseNextAction(snapshot, allowed, context);
    log(
      'chooseNextAction',
      `cycle=${context.cycle} allowed=[${allowed.join(', ')}] → ${result}`,
    );
    return result;
  }

  async shouldInterruptGather(state: GatherState): Promise<boolean> {
    const result = await this.inner.shouldInterruptGather(state);
    log(
      'shouldInterruptGather',
      `busy=${state.busy}, elsewhere=${state.busyElsewhere?.skill ?? 'none'} → ${result}`,
    );
    return result;
  }

  async decideHuntStop(state: HuntState): Promise<boolean> {
    const result = await this.inner.decideHuntStop(state);
    log(
      'decideHuntStop',
      `found=${state.totalEnemiesFound ?? 0}, remaining=${state.enemiesRemaining ?? '?'}, cards=${state.enemies.length} → ${result}`,
    );
    return result;
  }

  async chooseStance(enemy: EnemyInfo): Promise<Stance> {
    const result = await this.inner.chooseStance(enemy);
    log('chooseStance', `enemy="${enemy.name}" → ${result}`);
    return result;
  }

  async chooseMaxEnemies(enemy: EnemyInfo): Promise<number> {
    const result = await this.inner.chooseMaxEnemies(enemy);
    log('chooseMaxEnemies', `enemy="${enemy.name}" → ${result}`);
    return result;
  }

  async shouldFlee(battleState: BattleState): Promise<boolean> {
    const result = await this.inner.shouldFlee(battleState);
    log('shouldFlee', `hp=${battleState.playerHpPercent ?? '?'}% → ${result}`);
    return result;
  }

  async pickQuestPriority(quests: QuestInfo[]): Promise<string[]> {
    const result = await this.inner.pickQuestPriority(quests);
    log('pickQuestPriority', result.length > 0 ? result.join(', ') : '(keep gathering)');
    return result;
  }
}
