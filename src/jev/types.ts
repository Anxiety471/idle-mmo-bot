import type {
  BattleState,
  EnemyInfo,
  GatherState,
  HuntState,
  QuestInfo,
  Stance,
} from '../types.js';

/**
 * JevAdvisor — decision hooks for an AI agent ("Jev") that supervises
 * deterministic Playwright flows.
 *
 * Deterministic modules handle *how* to click; Jev decides *when* and *what*.
 * A real Jev implementation can call an LLM, rules engine, or remote API.
 *
 * ## Implementing a real Jev agent
 *
 * 1. Create a class that implements `JevAdvisor`.
 * 2. In each method, pass the current `state` snapshot (page text + parsed fields).
 * 3. Return conservative defaults on uncertainty (same as StubJev).
 * 4. Wire it in `cli.ts` via a `--jev` flag or env var (e.g. `JEV_PROVIDER=openai`).
 * 5. Log every decision for post-hoc review.
 *
 * Example skeleton:
 *
 * ```ts
 * class OpenAiJev implements JevAdvisor {
 *   async shouldInterruptGather(state: GatherState) {
 *     const reply = await llm.chat(
 *       `Gather busy=${state.busy}. Should we interrupt? Reply yes/no.`
 *     );
 *     return reply.includes('yes');
 *   }
 *   // ... implement remaining methods
 * }
 * ```
 */
export interface JevAdvisor {
  /** True → click "Start anyway" when gather restart hits a running action. */
  shouldInterruptGather(state: GatherState): Promise<boolean>;

  /** True → click Stop on hunt screen (after Jev's target enemy count). */
  decideHuntStop(state: HuntState): Promise<boolean>;

  chooseStance(enemy: EnemyInfo): Promise<Stance>;

  chooseMaxEnemies(enemy: EnemyInfo): Promise<number>;

  /** True → click Run Away during battle. */
  shouldFlee(battleState: BattleState): Promise<boolean>;

  /** Return quest titles in priority order (first = highest). */
  pickQuestPriority(quests: QuestInfo[]): Promise<string[]>;
}
