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
import { logJevCall, type JevMethodName } from '../logging/jev-log.js';
import type { SupervisorAdvisor } from './supervisor-advisor.js';

/**
 * Logs every Jev advisor method call to jev.jsonl (ProgressiveStubJev path).
 * HttpJev logs TypeSafe API details internally.
 */
export class LoggingJev implements SupervisorAdvisor {
  constructor(
    private readonly inner: SupervisorAdvisor,
    private readonly provider: 'ProgressiveStubJev' = 'ProgressiveStubJev',
  ) {}

  private async logMethod<T>(
    method: JevMethodName,
    result: T,
    fallback = false,
    error?: string,
  ): Promise<void> {
    await logJevCall({
      method,
      provider: this.provider,
      result,
      fallback,
      error,
    });
  }

  async chooseNextAction(
    snapshot: GameSnapshot,
    allowed: AutopilotAction[],
    context: AutopilotContext,
  ): Promise<AutopilotAction> {
    const result = await this.inner.chooseNextAction(snapshot, allowed, context);
    await this.logMethod('chooseNextAction', result);
    return result;
  }

  async shouldInterruptGather(state: GatherState): Promise<boolean> {
    const result = await this.inner.shouldInterruptGather(state);
    await this.logMethod('shouldInterruptGather', result);
    return result;
  }

  async decideHuntStop(state: HuntState): Promise<boolean> {
    const result = await this.inner.decideHuntStop(state);
    await this.logMethod('decideHuntStop', result);
    return result;
  }

  async chooseStance(enemy: EnemyInfo): Promise<Stance> {
    const result = await this.inner.chooseStance(enemy);
    await this.logMethod('chooseStance', result);
    return result;
  }

  async chooseMaxEnemies(enemy: EnemyInfo): Promise<number> {
    const result = await this.inner.chooseMaxEnemies(enemy);
    await this.logMethod('chooseMaxEnemies', result);
    return result;
  }

  async shouldFlee(battleState: BattleState): Promise<boolean> {
    const result = await this.inner.shouldFlee(battleState);
    await this.logMethod('shouldFlee', result);
    return result;
  }

  async pickQuestPriority(quests: QuestInfo[]): Promise<string[]> {
    const result = await this.inner.pickQuestPriority(quests);
    await this.logMethod('pickQuestPriority', result);
    return result;
  }
}
