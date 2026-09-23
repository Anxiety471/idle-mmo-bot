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
import type { Answer, Question, SystemOneResponse } from './typesafe-client.js';
import { TypeSafeClient } from './typesafe-client.js';
import { huntFoundCap } from './hunt-cap.js';
import { logJevCall, type JevMethodName } from '../logging/jev-log.js';

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
    questCurriculum: snapshot.extensions?.questCurriculum ?? null,
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

/**
 * HttpJev — real Jev advisor backed by the TypeSafe System One API.
 * Appends structured lines to logs/jev.jsonl for every call.
 */
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

  private async logLocal(method: JevMethodName, result: unknown): Promise<void> {
    await logJevCall({
      method,
      provider: 'HttpJev',
      model: this.config.model,
      result,
      fallback: false,
    });
  }

  private async withApiLog<T>(
    method: JevMethodName,
    state: unknown,
    questions: Record<string, Question>,
    answerKey: string,
    parse: (response: SystemOneResponse) => T,
    fallbackFn: () => Promise<T>,
  ): Promise<T> {
    try {
      const response = await this.client.systemOne(state, questions);
      const answer: Answer | undefined = response.answers[answerKey];
      const result = parse(response);
      await logJevCall({
        method,
        provider: 'HttpJev',
        model: response.model ?? this.config.model,
        usage: response.usage,
        answer,
        answers: response.answers,
        result,
        fallback: false,
      });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result = await fallbackFn();
      await logJevCall({
        method,
        provider: 'HttpJev',
        model: this.config.model,
        result,
        fallback: true,
        error: errorMessage,
      });
      this.logError(method, error);
      return result;
    }
  }

  async chooseNextAction(
    snapshot: GameSnapshot,
    allowed: AutopilotAction[],
    context: AutopilotContext,
  ): Promise<AutopilotAction> {
    if (allowed.length === 0) {
      await this.logLocal('chooseNextAction', 'idle');
      return 'idle';
    }
    if (allowed.length === 1) {
      await this.logLocal('chooseNextAction', allowed[0]);
      return allowed[0];
    }

    const playbook = snapshot.extensions?.earlySystemsPlaybook as
      | { curriculumHint?: string; stage?: string; preferredActions?: string[]; complete?: boolean }
      | undefined;
    const playbookHint =
      playbook && !playbook.complete
        ? ` ${playbook.curriculumHint ?? ''} Prefer among: ${(playbook.preferredActions ?? []).join(', ') || 'n/a'}. ` +
          `When questCurriculum shows an easy gather quest (e.g. Wood for the Hearth), prefer quest_talk_accept → gather_oak → quest_turnin over fish_cod and hard hunts.`
        : '';
    return this.withApiLog(
      'chooseNextAction',
      snapshotPayload(snapshot, context),
      {
        action: {
          type: 'choice',
          instructions:
            'Choose the single best next action to advance this Idle MMO account (quests, combat XP, skill training, crafting, selling junk). Prefer progress over passive waiting.' +
            playbookHint,
          criteria: actionCriteria(allowed, snapshot),
        },
      },
      'action',
      (response) => {
        const answer = response.answers.action;
        if (!answer || answer.type !== 'choice') {
          throw new Error('Missing choice answer for action');
        }
        if (!allowed.includes(answer.choice as AutopilotAction)) {
          throw new Error(`Jev chose disallowed action: ${answer.choice}`);
        }
        return answer.choice as AutopilotAction;
      },
      () => this.fallback.chooseNextAction(snapshot, allowed, context),
    );
  }

  async shouldInterruptGather(state: GatherState): Promise<boolean> {
    return this.withApiLog(
      'shouldInterruptGather',
      gatherPayload(state),
      {
        interrupt: {
          type: 'noul',
          instructions:
            'Should the bot interrupt the currently running gather/craft action and start a new one? If early playbook wants Coal/Cod and current resource is Oak/Yew, interrupt.',
          criteria: {
            true: 'Another action is blocking progress or combat/hunt is more valuable now',
            false: 'Keep the current gather/craft running; do not replace it',
          },
        },
      },
      'interrupt',
      (response) => {
        const answer = response.answers.interrupt;
        if (!answer || answer.type !== 'noul') {
          throw new Error('Missing noul answer for interrupt');
        }
        return noulYes(answer, this.config.noulThreshold);
      },
      () => this.fallback.shouldInterruptGather(state),
    );
  }

  async decideHuntStop(state: HuntState): Promise<boolean> {
    const foundCap = huntFoundCap(state.combatLevel, state.totalLevel);
    const stop = (state.totalEnemiesFound ?? 0) >= foundCap;
    await logJevCall({
      method: 'decideHuntStop',
      provider: 'HttpJev',
      model: this.config.model,
      result: stop,
      fallback: false,
      answer: { type: 'noul', noul: stop ? 1 : 0 },
    });
    return stop;
  }

  async chooseStance(enemy: EnemyInfo): Promise<Stance> {
    return this.withApiLog(
      'chooseStance',
      enemyPayload(enemy),
      {
        stance: {
          type: 'choice',
          instructions: `Choose the best combat stance against ${enemy.name}.`,
          criteria: STANCE_CRITERIA,
        },
      },
      'stance',
      (response) => {
        const answer = response.answers.stance;
        if (!answer || answer.type !== 'choice') {
          throw new Error('Missing choice answer for stance');
        }
        if (!isStance(answer.choice)) {
          throw new Error(`Unknown stance choice: ${answer.choice}`);
        }
        return answer.choice;
      },
      () => this.fallback.chooseStance(enemy),
    );
  }

  async chooseMaxEnemies(enemy: EnemyInfo): Promise<number> {
    return this.withApiLog(
      'chooseMaxEnemies',
      enemyPayload(enemy),
      {
        maxEnemies: {
          type: 'score',
          instructions: `How many enemies should the bot fight at once against ${enemy.name}?`,
          criteria: MAX_ENEMIES_CRITERIA,
        },
      },
      'maxEnemies',
      (response) => {
        const answer = response.answers.maxEnemies;
        if (!answer || answer.type !== 'score') {
          throw new Error('Missing score answer for maxEnemies');
        }
        return parseMaxEnemies(answer.score);
      },
      () => this.fallback.chooseMaxEnemies(enemy),
    );
  }

  async shouldFlee(battleState: BattleState): Promise<boolean> {
    return this.withApiLog(
      'shouldFlee',
      battlePayload(battleState),
      {
        flee: {
          type: 'noul',
          instructions: 'Should the bot run away from this battle to avoid defeat?',
          criteria: {
            true: 'HP is low or the fight is going poorly',
            false: 'Stay and continue fighting',
          },
        },
      },
      'flee',
      (response) => {
        const answer = response.answers.flee;
        if (!answer || answer.type !== 'noul') {
          throw new Error('Missing noul answer for flee');
        }
        return noulYes(answer, this.config.noulThreshold);
      },
      () => this.fallback.shouldFlee(battleState),
    );
  }

  async pickQuestPriority(quests: QuestInfo[]): Promise<string[]> {
    if (quests.length === 0) return [];

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

    return this.withApiLog(
      'pickQuestPriority',
      questPayload(quests),
      {
        priority: {
          type: 'choice',
          instructions: 'Which quest should the bot work on first?',
          criteria,
        },
      },
      'priority',
      (response) => {
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
      },
      () => this.fallback.pickQuestPriority(quests),
    );
  }
}
