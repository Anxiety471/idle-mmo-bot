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
import type { JevConfig } from './jev-config.js';
import { actionCriteria } from './action-descriptions.js';
import { ProgressiveStubJev } from './progressive-stub.js';
import type { SupervisorAdvisor } from './supervisor-advisor.js';
import { TypeSafeClient } from './typesafe-client.js';

const STANCES: Stance[] = ['Balanced', 'Offensive', 'Defensive', 'Agile', 'Dexterous'];

const STANCE_CRITERIA: Record<string, string> = {
  Balanced: 'Even offense and defense for general hunting',
  Offensive: 'Prioritize damage when the enemy is weak',
  Defensive: 'Prioritize survivability against tough enemies',
  Agile: 'Speed and evasion for fast enemies',
  Dexterous: 'Precision and critical hits',
};

const MAX_ENEMIES_CRITERIA = [
  '1 enemy — safest, lowest risk',
  '2 enemies — light multi-target',
  '3 enemies — moderate risk',
  '4 enemies — high risk',
  '5 enemies — maximum risk and reward',
];

function gatherPayload(state: GatherState): Record<string, unknown> {
  return {
    context: 'gather_interrupt',
    busy: state.busy,
    busyElsewhere: state.busyElsewhere ?? null,
    currentResource: state.currentResource ?? null,
    skill: state.skill ?? null,
  };
}

function huntPayload(state: HuntState): Record<string, unknown> {
  return {
    context: 'hunt_stop',
    enemies: state.enemies,
    defeatedCount: state.defeatedCount,
    totalEnemiesFound: state.totalEnemiesFound ?? null,
    enemiesRemaining: state.enemiesRemaining ?? null,
    bonusEnemies: state.bonusEnemies ?? null,
  };
}

function battlePayload(state: BattleState): Record<string, unknown> {
  return {
    context: 'battle_flee',
    inBattle: state.inBattle,
    playerHpPercent: state.playerHpPercent ?? null,
    enemyName: state.enemyName ?? null,
  };
}

function enemyPayload(enemy: EnemyInfo): Record<string, unknown> {
  return {
    context: 'enemy_battle_config',
    enemy,
  };
}

function questPayload(quests: QuestInfo[]): Record<string, unknown> {
  return {
    context: 'quest_priority',
    quests: quests.map((q) => ({
      title: q.title,
      progress: q.progress ?? null,
      canTurnIn: q.canTurnIn,
      isOpen: q.isOpen,
    })),
  };
}

function noulYes(answer: { noul: number }, threshold: number): boolean {
  return answer.noul >= threshold;
}

function parseMaxEnemies(score: number): number {
  const rounded = Math.round(score);
  return Math.min(5, Math.max(1, rounded + 1));
}

function isStance(value: string): value is Stance {
  return STANCES.includes(value as Stance);
}

/**
 * HttpJev — real Jev advisor backed by the TypeSafe System One API.
 *
 * On API failure, falls back to StubJev behavior and logs the error.
 */
function snapshotPayload(snapshot: GameSnapshot, context: AutopilotContext): Record<string, unknown> {
  return {
    context: 'autopilot_supervisor',
    cycle: context.cycle,
    location: snapshot.location,
    totalLevel: snapshot.totalLevel ?? null,
    combatLevel: snapshot.combatLevel ?? null,
    gold: snapshot.gold ?? null,
    tokens: snapshot.tokens ?? null,
    currentAction: snapshot.currentAction ?? null,
    skillLevels: snapshot.skillLevels,
    inventory: snapshot.inventory,
    acceptedQuests: snapshot.acceptedQuests,
    pendingQuests: snapshot.pendingQuests,
    combatPhase: snapshot.combatPhase,
    zones: snapshot.zones ?? [],
    features: snapshot.features ?? {},
    discovered: snapshot.discovered ?? {},
    extensions: snapshot.extensions ?? {},
    flags: snapshot.flags,
    lastAction: context.lastAction ?? null,
    gatherRotationIndex: context.gatherRotationIndex,
  };
}

export class HttpJev implements SupervisorAdvisor {
  private readonly client: TypeSafeClient;
  private readonly fallback = new ProgressiveStubJev();

  constructor(private readonly config: JevConfig) {
    this.client = new TypeSafeClient(config);
  }

  private logError(method: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Jev:Http] ${method} failed, using ProgressiveStubJev fallback: ${message}`);
  }

  async chooseNextAction(
    snapshot: GameSnapshot,
    allowed: AutopilotAction[],
    context: AutopilotContext,
  ): Promise<AutopilotAction> {
    if (allowed.length === 0) return 'idle';
    if (allowed.length === 1) return allowed[0];

    try {
      const response = await this.client.systemOne(snapshotPayload(snapshot, context), {
        action: {
          type: 'choice',
          instructions:
            'Choose the single best next action to advance this Idle MMO account (quests, combat XP, skill training, crafting, selling junk). Prefer progress over passive waiting.',
          criteria: actionCriteria(allowed),
        },
      });

      const answer = response.answers.action;
      if (!answer || answer.type !== 'choice') {
        throw new Error('Missing choice answer for action');
      }

      if (allowed.includes(answer.choice as AutopilotAction)) {
        return answer.choice as AutopilotAction;
      }

      throw new Error(`Jev chose disallowed action: ${answer.choice}`);
    } catch (error) {
      this.logError('chooseNextAction', error);
      return this.fallback.chooseNextAction(snapshot, allowed, context);
    }
  }

  async shouldInterruptGather(state: GatherState): Promise<boolean> {
    try {
      const response = await this.client.systemOne(gatherPayload(state), {
        interrupt: {
          type: 'noul',
          instructions:
            'Should the bot interrupt the currently running gather/craft action and start a new one?',
          criteria: {
            true: 'Another action is blocking progress or combat/hunt is more valuable now',
            false: 'Keep the current gather/craft running; do not replace it',
          },
        },
      });

      const answer = response.answers.interrupt;
      if (!answer || answer.type !== 'noul') {
        throw new Error('Missing noul answer for interrupt');
      }

      return noulYes(answer, this.config.noulThreshold);
    } catch (error) {
      this.logError('shouldInterruptGather', error);
      return this.fallback.shouldInterruptGather(state);
    }
  }

  async decideHuntStop(state: HuntState): Promise<boolean> {
    try {
      const response = await this.client.systemOne(huntPayload(state), {
        stop: {
          type: 'noul',
          instructions:
            'Should the bot stop the current hunt now to select enemies and start battle?',
          criteria: {
            true: 'Enough enemies found or remaining count is low enough to stop and battle',
            false: 'Keep hunting to find more enemies before stopping',
          },
        },
      });

      const answer = response.answers.stop;
      if (!answer || answer.type !== 'noul') {
        throw new Error('Missing noul answer for stop');
      }

      return noulYes(answer, this.config.noulThreshold);
    } catch (error) {
      this.logError('decideHuntStop', error);
      return this.fallback.decideHuntStop(state);
    }
  }

  async chooseStance(enemy: EnemyInfo): Promise<Stance> {
    try {
      const response = await this.client.systemOne(enemyPayload(enemy), {
        stance: {
          type: 'choice',
          instructions: `Choose the best combat stance against ${enemy.name}.`,
          criteria: STANCE_CRITERIA,
        },
      });

      const answer = response.answers.stance;
      if (!answer || answer.type !== 'choice') {
        throw new Error('Missing choice answer for stance');
      }

      if (isStance(answer.choice)) {
        return answer.choice;
      }

      throw new Error(`Unknown stance choice: ${answer.choice}`);
    } catch (error) {
      this.logError('chooseStance', error);
      return this.fallback.chooseStance(enemy);
    }
  }

  async chooseMaxEnemies(enemy: EnemyInfo): Promise<number> {
    try {
      const response = await this.client.systemOne(enemyPayload(enemy), {
        maxEnemies: {
          type: 'score',
          instructions: `How many enemies should the bot fight at once against ${enemy.name}?`,
          criteria: MAX_ENEMIES_CRITERIA,
        },
      });

      const answer = response.answers.maxEnemies;
      if (!answer || answer.type !== 'score') {
        throw new Error('Missing score answer for maxEnemies');
      }

      return parseMaxEnemies(answer.score);
    } catch (error) {
      this.logError('chooseMaxEnemies', error);
      return this.fallback.chooseMaxEnemies(enemy);
    }
  }

  async shouldFlee(battleState: BattleState): Promise<boolean> {
    try {
      const response = await this.client.systemOne(battlePayload(battleState), {
        flee: {
          type: 'noul',
          instructions: 'Should the bot run away from this battle to avoid defeat?',
          criteria: {
            true: 'HP is low or the fight is going poorly',
            false: 'Stay and continue fighting',
          },
        },
      });

      const answer = response.answers.flee;
      if (!answer || answer.type !== 'noul') {
        throw new Error('Missing noul answer for flee');
      }

      return noulYes(answer, this.config.noulThreshold);
    } catch (error) {
      this.logError('shouldFlee', error);
      return this.fallback.shouldFlee(battleState);
    }
  }

  async pickQuestPriority(quests: QuestInfo[]): Promise<string[]> {
    if (quests.length === 0) return [];

    try {
      const criteria: Record<string, string> = {
        keep_gathering: 'Continue gathering/crafting; defer quest work for now',
      };
      for (const quest of quests) {
        const detail = [
          quest.canTurnIn ? 'ready to turn in' : 'in progress',
          quest.progress ? `progress: ${quest.progress}` : null,
        ]
          .filter(Boolean)
          .join('; ');
        criteria[quest.title] = `Work on quest "${quest.title}" (${detail})`;
      }

      const response = await this.client.systemOne(questPayload(quests), {
        priority: {
          type: 'choice',
          instructions: 'Which quest should the bot work on first?',
          criteria,
        },
      });

      const answer = response.answers.priority;
      if (!answer || answer.type !== 'choice') {
        throw new Error('Missing choice answer for priority');
      }

      if (answer.choice === 'keep_gathering') {
        return [];
      }

      const chosen = quests.find((q) => q.title === answer.choice);
      if (!chosen) {
        throw new Error(`Unknown quest choice: ${answer.choice}`);
      }

      const rest = quests.filter((q) => q.title !== chosen.title).map((q) => q.title);
      return [chosen.title, ...rest];
    } catch (error) {
      this.logError('pickQuestPriority', error);
      return this.fallback.pickQuestPriority(quests);
    }
  }
}
