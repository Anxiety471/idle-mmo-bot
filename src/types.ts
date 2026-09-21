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

export type InventoryStepResult = 'sold' | 'no_action' | 'failed';

/**
 * Supervisor loop action id — open-ended string.
 * Bootstrap ids are registered at startup; new loops add ids via registerDiscoveredAction().
 */
export type AutopilotAction = string;

/** Well-known bootstrap action ids (not exhaustive as the bot discovers more loops). */
export const BOOTSTRAP_ACTION_IDS = {
  continue_current: 'continue_current',
  gather_oak: 'gather_oak',
  gather_yew: 'gather_yew',
  mine_coal: 'mine_coal',
  fish_cod: 'fish_cod',
  cook_cod: 'cook_cod',
  buy_bait: 'buy_bait',
  hunt_battle: 'hunt_battle',
  quest_talk_accept: 'quest_talk_accept',
  quest_turnin: 'quest_turnin',
  craft_if_ready: 'craft_if_ready',
  sell_junk: 'sell_junk',
  market_sell_half: 'market_sell_half',
  hunt_rabbits: 'hunt_rabbits',
  explore_map: 'explore_map',
  idle: 'idle',
} as const;

export type CombatPhase = 'hunt' | 'battle' | 'enemy_select' | 'none';

export interface SnapshotQuest {
  title: string;
  progress?: string;
  canTurnIn: boolean;
  tab: 'accepted' | 'pending' | 'completed';
}

export interface CurrentActionInfo {
  busy: boolean;
  skill?: SkillId;
  resource?: string;
  label?: string;
}

export interface SnapshotZone {
  name: string;
  levelReq?: number;
  current?: boolean;
}

export interface DiscoveredFeature {
  label: string;
  route: string;
  scriptable: boolean;
  note: string;
}

export interface GameSnapshot {
  location: string;
  pagePath: string;
  totalLevel?: number;
  combatLevel?: number;
  gold?: number;
  tokens?: number;
  currentAction?: CurrentActionInfo;
  skillLevels: Partial<Record<SkillId, number>>;
  inventory: Record<string, number>;
  acceptedQuests: SnapshotQuest[];
  pendingQuests: SnapshotQuest[];
  combatPhase: CombatPhase;
  zones?: SnapshotZone[];
  features?: Record<string, boolean | string | number>;
  discovered?: {
    features?: DiscoveredFeature[];
    unregisteredRoutes?: string[];
  };
  /** Enricher-specific payloads; safe to extend without breaking Jev. */
  extensions?: Record<string, unknown>;
  flags: {
    hasBait: boolean;
    bankNearby: boolean;
    gatherBusy: boolean;
    inBattle: boolean;
    sessionValid: boolean;
  };
}

export interface AutopilotContext {
  cycle: number;
  gatherRotationIndex: number;
  lastAction?: AutopilotAction;
}

export interface ActionResult {
  action: AutopilotAction;
  outcome: string;
  backoffMs?: number;
}
