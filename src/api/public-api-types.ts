import type {
  CombatPhase,
  CurrentActionInfo,
  SkillId,
  SnapshotQuest,
  SnapshotZone,
} from '../types.js';

/** Fields the Public API may override on a Playwright GameSnapshot. */
export interface PublicApiSnapshotPatch {
  location?: string;
  zones?: SnapshotZone[];
  totalLevel?: number;
  combatLevel?: number;
  gold?: number;
  tokens?: number;
  skillLevels?: Partial<Record<SkillId, number>>;
  /**
   * Keys present here replace the DOM quantity, including zero.
   * Keys absent from this object keep the scraped value.
   */
  inventory?: Record<string, number>;
  acceptedQuests?: SnapshotQuest[];
  pendingQuests?: SnapshotQuest[];
  combatPhase?: CombatPhase;
  totalEnemiesFound?: number;
  enemiesRemaining?: number;
  currentAction?: CurrentActionInfo;
  bankNearby?: boolean;
  weather?: string;
  /** Listed pets from `GET /v1/character/{hashed_character_id}/pets`. */
  pets?: Record<string, unknown>[];
  /** Equipped pet fields from character information. */
  equippedPet?: Record<string, unknown>;
  identity?: {
    hashedId?: string;
    onlineStatus?: string;
    names?: string[];
    /** Documented `current_status`. Not translated into combat phase. */
    currentStatus?: unknown;
  };
}

export interface UnavailableResource {
  id: string;
  role: string;
  reason: 'path-unpublished' | 'missing-guild-id' | 'missing-character-id';
  snapshotFields: string[];
  summary: string;
}

export interface PublicApiErrorInfo {
  id: string;
  code: string;
  message: string;
  status?: number;
}

export interface PublicApiRead {
  ok: boolean;
  fromCache: boolean;
  fetchedAt: number;
  endpointsUsed: string[];
  errors: PublicApiErrorInfo[];
  unavailable: UnavailableResource[];
  patch: PublicApiSnapshotPatch;
  /** Sanitized extension payload. Never includes the API key. */
  meta: Record<string, unknown>;
}
