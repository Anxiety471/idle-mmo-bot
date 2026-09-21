/** Shared domain types for deterministic flows and Jev advisors. */

export type Stance =
  | 'Balanced'
  | 'Offensive'
  | 'Defensive'
  | 'Agile'
  | 'Dexterous';

export type SkillId =
  | 'woodcutting'
  | 'mining'
  | 'fishing'
  | 'alchemy'
  | 'smelting'
  | 'cooking'
  | 'forge'
  | 'construction';

export interface ActiveGatherElsewhere {
  skill: SkillId;
  resource?: string;
}

export interface GatherState {
  /** True when this skill's page shows CURRENT ACTION. */
  busy: boolean;
  /** When busy is false but another skill page shows CURRENT ACTION (one action at a time). */
  busyElsewhere?: ActiveGatherElsewhere;
  /** Current resource label if detectable from UI text. */
  currentResource?: string;
  /** Skill page this state was read from. */
  skill?: SkillId;
  /** Raw page text snapshot for advisor context. */
  pageText: string;
}

export interface EnemyInfo {
  name: string;
  /** Index among visible enemy cards on the hunt screen. */
  index: number;
}

export interface HuntState {
  /** Enemy card buttons (visible after Stop, for Battle selection). */
  enemies: EnemyInfo[];
  /** Number of enemies already defeated this hunt (if detectable). */
  defeatedCount: number;
  /** Hunt metrics while Stop is active — cards are not shown until Stop. */
  totalEnemiesFound?: number;
  enemiesRemaining?: number;
  bonusEnemies?: number;
  pageText: string;
}

export interface BattleState {
  inBattle: boolean;
  /** Player HP percentage 0–100 if detectable from UI. */
  playerHpPercent?: number;
  /** Enemy name if detectable. */
  enemyName?: string;
  pageText: string;
}

export interface QuestInfo {
  title: string;
  /** Progress text e.g. "Oak Log 42 / 150" if visible. */
  progress?: string;
  /** Whether Turn In button appears enabled. */
  canTurnIn: boolean;
  /** Whether quest is currently open/selected in the UI. */
  isOpen: boolean;
}

export interface QuestState {
  quests: QuestInfo[];
  pageText: string;
}

export type GatherRestartResult =
  | 'already_busy'
  | 'another_action_active'
  | 'restarted'
  | 'kept_current_action'
  | 'missing_requirement'
  | 'failed';

export type CombatStepResult =
  | 'hunt_started'
  | 'hunt_already_active'
  | 'enemy_select_ready'
  | 'enemy_selected'
  | 'battle_started'
  | 'battle_in_progress'
  | 'hunt_stopped'
  | 'fled'
  | 'hunt_more_clicked'
  | 'no_action'
  | 'failed';

export type QuestStepResult =
  | 'opened'
  | 'talked'
  | 'turned_in'
  | 'in_progress'
  | 'no_action'
  | 'failed';

export type MerchantStepResult = 'purchased' | 'failed' | 'no_action';
