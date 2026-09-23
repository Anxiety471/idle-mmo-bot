/**
 * Early-systems playbook — curriculum / stage targets + allowed-action filters.
 *
 * HttpJev remains the decision brain. This module only:
 *  - tracks batch loop progress (coal → sell → bait → fish → cook → hunt → repeat)
 *  - hard sequential gates by real counts only (not busy-cycle estimates):
 *      coal → fish → cook → hunt (no sell after cook); snap back to first unmet stage if stuck ahead
 *  - pets are async/opportunistic (soft prefer / interrupt), NOT a sequential batch stage
 *  - default batch targets: ~100 coal, ~100 fish, ~100 cook, ~120 hunt/battle (env-overridable)
 *  - exposes preferred / deprioritized actions into the snapshot for Jev
 *  - filters allowed actions so endless Oak woodcutting loses priority until the run completes
 *  - missions-first early gold: quest_turnin / quest_talk_accept before market sell when quests
 *    are available; sell actions remain fallback when quests are dry or unavailable
 *
 * Hard constraints (huntFoundCap, no membership spend, gold Cheap Bait only) stay elsewhere.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogDir } from '../logging/jsonl-writer.js';
import { needsCookBeforeHunt } from '../deterministic/combat.js';
import { shouldHardStopHunt } from '../deterministic/hunt-cap.js';
import { hasEasyCompletePendingQuest } from '../deterministic/quest-accept.js';
import type { AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';
import {
  evaluateQuestCurriculum,
  getQuestCurriculumFromSnapshot,
  type QuestCurriculum,
} from './quest-curriculum.js';

export type { QuestCurriculum, ScoredQuest } from './quest-curriculum.js';
export { evaluateQuestCurriculum, getQuestCurriculumFromSnapshot } from './quest-curriculum.js';

export type EarlyStageId =
  | 'mine_coal'
  | 'sell_half'
  | 'buy_bait'
  | 'fish_cod'
  | 'cook_cod'
  | 'sell_extras'
  | 'hunt_battle_batch'
  /** @deprecated persisted alias — normalized to hunt_battle_batch on load */
  | 'hunt_rabbits'
  | 'manage_pets'
  | 'explore_map'
  | 'complete';

export interface PlaybookCounts {
  coal: number;
  rawCod: number;
  cookedCod: number;
  sells: number;
  huntBattles: number;
  /** @deprecated migrated to huntBattles */
  rabbitHunts?: number;
  mapPeeks: number;
  /** Successful manage_pets ticks this batch (async; does not gate the batch loop). */
  petManages: number;
  /** Completed full coal→fish→cook→hunt cycles (pets are async, not counted here). */
  batchCycles: number;
  /** Cycles observed while CURRENT ACTION was Coal (inventory often icon-only). */
  coalBusyCycles: number;
  codBusyCycles: number;
}

export interface PlaybookProgress {
  enabled: boolean;
  stage: EarlyStageId;
  stageIndex: number;
  stageGoal: string;
  preferredActions: AutopilotAction[];
  deprioritizedActions: AutopilotAction[];
  /** Actions that should be force-allowed even when gatherBusy (interrupt path). */
  interruptActions: AutopilotAction[];
  counts: PlaybookCounts;
  /** True after a successful Cheap Bait purchase (inventory scrape is often empty/icon-only). */
  baitOwned: boolean;
  /** ISO time of last successful buy_bait; used for repurchase cooldown. */
  lastBaitPurchaseAt?: string;
  targets: {
    coalMin: number;
    coalMax: number;
    codMin: number;
    codMax: number;
    cookMin: number;
    huntMin: number;
  };
  curriculumHint: string;
  complete: boolean;
  /** True while waiting for CURRENT ACTION after a gather restart (probe gap). */
  gatherGraceActive: boolean;
  gatherGraceSkill?: string;
  gatherGraceResource?: string;
  /** True after repeated fish_cod start failures — temporarily prefer fallback actions. */
  fishCodBackoffActive: boolean;
  /** ISO time when fish_cod retries resume after backoff. */
  fishCodBackoffUntil?: string;
  /** Consecutive fish_cod failed/fishing_start_failed outcomes (resets on success). */
  consecutiveFishCodFailures: number;
  /**
   * True when snapshot claims busy mining coal but inventory/playbook coal has not
   * increased across several poll cycles (false-busy or non-producing gather).
   */
  staleCoalGather: boolean;
  /** Consecutive flat coal-while-busy cycles (debug / tests). */
  staleCoalBusyCycles: number;
  /** Per-tick quest difficulty/importance scoring for HttpJev + filters. */
  questCurriculum?: QuestCurriculum;
}

interface PersistedPlaybook {
  version: 1;
  stage: EarlyStageId;
  counts: PlaybookCounts;
  /**
   * Sticky trust that bait was purchased.
   * NEVER cleared on fish_cod missing_requirement/failed — those are UI/start failures.
   */
  baitOwned?: boolean;
  lastBaitPurchaseAt?: string;
  completedAt?: string;
  lastGatherRestartAt?: string;
  lastGatherSkill?: string;
  lastGatherResource?: string;
  consecutiveFishCodFailures?: number;
  fishCodBackoffUntil?: string;
  /** Last observed effective coal count used for stale-busy detection. */
  lastCoalProgressSeen?: number;
  /** Consecutive evaluate ticks busy on coal with flat coal progress. */
  staleCoalBusyCycles?: number;
}

/** Sequential batch stages only — manage_pets is async and not in this order. */
const STAGE_ORDER: EarlyStageId[] = [
  'mine_coal',
  'sell_half',
  'buy_bait',
  'fish_cod',
  'cook_cod',
  'hunt_battle_batch',
  'explore_map',
  'complete',
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Batch leveling defaults (user: 100 coal → 100 fish → 100 cook → ~120 hunt). */
const COAL_MIN = envInt('PLAYBOOK_COAL_TARGET', 100);
const COAL_MAX = envInt('PLAYBOOK_COAL_MAX', COAL_MIN);
const COD_MIN = envInt('PLAYBOOK_FISH_TARGET', 100);
const COD_MAX = envInt('PLAYBOOK_FISH_MAX', COD_MIN);
const COOK_MIN = envInt('PLAYBOOK_COOK_TARGET', 100);
const HUNT_MIN = envInt('PLAYBOOK_HUNT_TARGET', 120);

/** Quest actions preferred over market sell for early gold while playbook is active. */
export const EARLY_GOLD_QUEST_ACTIONS: AutopilotAction[] = ['quest_turnin', 'quest_talk_accept'];
/** Sell actions demoted when quests can fund early progression. */
export const EARLY_GOLD_SELL_ACTIONS: AutopilotAction[] = [
  'sell_junk_for_gold',
  'market_sell_half',
  'sell_junk',
];
export const BAIT_GOLD_COST = 2;

const EARLY_GOLD_SELL_SET = new Set<AutopilotAction>(EARLY_GOLD_SELL_ACTIONS);
/** Grace window after restartSkillGather before re-injecting interrupt gathers. */
export const GATHER_GRACE_MS = 30_000;
/** After buy_bait success, refuse another purchase for this long (or until stage advances). */
export const BAIT_PURCHASE_COOLDOWN_MS = 15 * 60_000;
/** Consecutive fish_cod start failures before temporary playbook fallback. */
export const FISH_COD_FAILURE_THRESHOLD = 4;
/** Cooldown before re-injecting fish_cod after backoff (stage stays fish_cod). */
export const FISH_COD_BACKOFF_MS = 3 * 60_000;
/**
 * Busy-on-coal cycles with flat inventory/playbook coal before treating gather as stale.
 * ~6–8 autopilot polls (~2–10 min depending on pollMs) — real mining should move coal sooner.
 */
export const STALE_COAL_BUSY_CYCLES = envInt('PLAYBOOK_STALE_COAL_BUSY_CYCLES', 6);
/** Fallback actions while fish_cod backoff is active (baitOwned is never cleared). */
export const FISH_COD_BACKOFF_FALLBACKS: AutopilotAction[] = [
  'continue_current',
  'cook_cod',
  'mine_coal',
  'sell_junk_for_gold',
  'idle',
];
/**
 * Soft-prefer manage_pets every N completed batch cycles (not a hard gate).
 * Maintenance may run while busy; equip_pet is idle-only.
 * Override with PLAYBOOK_PETS_EVERY_N_CYCLES.
 */
export const PETS_ASYNC_EVERY_N_CYCLES = envInt('PLAYBOOK_PETS_EVERY_N_CYCLES', 1);

/** Resolved at call time so AUTOPILOT_LOG_DIR is honored after env load. */
export function resolvePlaybookStatePath(): string {
  const override = process.env.PLAYBOOK_STATE_PATH?.trim();
  if (override) return override;
  return join(getLogDir(), 'playbook-state.json');
}

const GATHER_RESOURCE: Record<string, RegExp> = {
  mine_coal: /coal/i,
  fish_cod: /\bcod\b/i,
  cook_cod: /cook/i,
  gather_oak: /oak/i,
  gather_yew: /yew/i,
};


/** Normalize legacy stage / counter names from persisted JSON. */
export function normalizeEarlyStageId(stage: string): EarlyStageId {
  if (stage === 'hunt_rabbits') return 'hunt_battle_batch';
  return stage as EarlyStageId;
}

function normalizePlaybookCounts(raw: Partial<PlaybookCounts> | undefined): PlaybookCounts {
  const base = { ...emptyCounts(), ...(raw ?? {}) };
  const migrated = Math.max(base.huntBattles ?? 0, base.rabbitHunts ?? 0);
  return { ...base, huntBattles: migrated, rabbitHunts: undefined };
}

function emptyCounts(): PlaybookCounts {
  return {
    coal: 0,
    rawCod: 0,
    cookedCod: 0,
    sells: 0,
    huntBattles: 0,
    mapPeeks: 0,
    petManages: 0,
    batchCycles: 0,
    coalBusyCycles: 0,
    codBusyCycles: 0,
  };
}

/** Reset per-batch resource counters while keeping cycle totals / bait trust. */
function resetBatchResourceCounts(counts: PlaybookCounts): PlaybookCounts {
  return {
    ...counts,
    coal: 0,
    rawCod: 0,
    cookedCod: 0,
    sells: 0,
    huntBattles: 0,
    petManages: 0,
    coalBusyCycles: 0,
    codBusyCycles: 0,
    batchCycles: counts.batchCycles + 1,
  };
}

function playbookEnabled(): boolean {
  const raw = process.env.EARLY_PLAYBOOK?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true; // on by default for IdleBocchi early run
}

function loadPersisted(): PersistedPlaybook {
  try {
    const statePath = resolvePlaybookStatePath();
    if (!existsSync(statePath)) {
      return { version: 1, stage: 'mine_coal', counts: emptyCounts() };
    }
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as PersistedPlaybook;
    if (parsed?.version !== 1 || !parsed.stage) {
      return { version: 1, stage: 'mine_coal', counts: emptyCounts() };
    }
    return {
      version: 1,
      stage: normalizeEarlyStageId(String(parsed.stage)),
      counts: normalizePlaybookCounts(parsed.counts),
      baitOwned: Boolean(parsed.baitOwned),
      lastBaitPurchaseAt: parsed.lastBaitPurchaseAt,
      completedAt: parsed.completedAt,
      lastGatherRestartAt: parsed.lastGatherRestartAt,
      lastGatherSkill: parsed.lastGatherSkill,
      lastGatherResource: parsed.lastGatherResource,
      consecutiveFishCodFailures: parsed.consecutiveFishCodFailures ?? 0,
      fishCodBackoffUntil: parsed.fishCodBackoffUntil,
      lastCoalProgressSeen: parsed.lastCoalProgressSeen,
      staleCoalBusyCycles: parsed.staleCoalBusyCycles ?? 0,
    };
  } catch {
    return { version: 1, stage: 'mine_coal', counts: emptyCounts() };
  }
}

function savePersisted(state: PersistedPlaybook): void {
  try {
    const statePath = resolvePlaybookStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[playbook] failed to persist state: ${message}`);
  }
}

function invCount(snapshot: GameSnapshot, names: string[]): number {
  let max = 0;
  for (const name of names) {
    max = Math.max(max, snapshot.inventory[name] ?? 0);
  }
  // Exact / word-boundary fuzzy keys so "Cod" does not match "Code of Conduct".
  for (const [key, qty] of Object.entries(snapshot.inventory)) {
    const keyLower = key.toLowerCase();
    for (const n of names) {
      const nLower = n.toLowerCase();
      if (keyLower === nLower) {
        max = Math.max(max, qty);
        continue;
      }
      const escaped = nLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`);
      if (re.test(keyLower)) max = Math.max(max, qty);
    }
  }
  return max;
}


/** Inventory is icon-heavy; trust merchant purchase + stage progression as bait presence. */
function trustHasBait(snapshot: GameSnapshot, baitOwned: boolean, stage: EarlyStageId): boolean {
  if (snapshot.flags.hasBait) return true;
  if (invCount(snapshot, ['Cheap Bait', 'Bait']) > 0) return true;
  if (baitOwned) return true;
  // Once past buy_bait, assume bait was obtained (recovers from pre-baitOwned runs).
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx > STAGE_ORDER.indexOf('buy_bait')) return true;
  return false;
}


/** True when a successful buy_bait is still within the repurchase cooldown window. */
export function recentBaitPurchase(lastBaitPurchaseAt: string | undefined): boolean {
  if (!lastBaitPurchaseAt) return false;
  const elapsed = Date.now() - new Date(lastBaitPurchaseAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < BAIT_PURCHASE_COOLDOWN_MS;
}

/**
 * Prefer bait restock on fish_cod when scrape shows <15 Cheap Bait/Bait.
 * After a successful buy_bait, trust purchased stock until cooldown expires even if scrape undercounts.
 */
export function shouldPreferBaitRestock(
  stage: EarlyStageId | string | undefined,
  baitStock: number,
  lastBaitPurchaseAt: string | undefined,
): boolean {
  if (stage !== 'fish_cod') return false;
  if (recentBaitPurchase(lastBaitPurchaseAt)) return false;
  return baitStock < 15;
}


function syncCountsFromSnapshot(
  counts: PlaybookCounts,
  snapshot: GameSnapshot,
  options?: { creditCodGrace?: boolean },
): PlaybookCounts {
  const next = { ...counts };
  const coal = invCount(snapshot, ['Coal Ore', 'Coal']);
  const rawCod = invCount(snapshot, ['Cod', 'Raw Cod']);
  const cooked = invCount(snapshot, ['Cooked Cod']);
  // CURRENT ACTION "+N" is a live floor while icon inventory under-reports.
  const produced =
    /coal/i.test(snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '')
      ? snapshot.currentAction?.producedCount ?? 0
      : 0;
  if (coal > 0) next.coal = Math.max(next.coal, coal);
  if (produced > 0) next.coal = Math.max(next.coal, produced);
  if (rawCod > 0) next.rawCod = Math.max(next.rawCod, rawCod);
  if (cooked > 0) next.cookedCod = Math.max(next.cookedCod, cooked);

  const resource = snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '';
  if (/coal/i.test(resource)) next.coalBusyCycles += 1;
  if (/\bcod\b/i.test(resource) && snapshot.currentAction?.skill === 'fishing') {
    next.codBusyCycles += 1;
  } else if (options?.creditCodGrace) {
    next.codBusyCycles += 1;
  }
  return next;
}


/** Busy mining Coal Ore (or label contains coal) for stale-progress detection. */
function isBusyMiningCoal(snapshot: GameSnapshot): boolean {
  const busy = Boolean(snapshot.currentAction?.busy || snapshot.flags.gatherBusy);
  if (!busy) return false;
  const resource = snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '';
  return /coal/i.test(resource);
}

/**
 * Track flat coal while snapshot says busy mining coal.
 * Returns updated anchor + consecutive flat cycles (does not use busy estimates for gates).
 */
export function updateStaleCoalBusyTracking(
  persisted: {
    lastCoalProgressSeen?: number;
    staleCoalBusyCycles?: number;
  },
  effectiveCoal: number,
  busyMiningCoal: boolean,
): { lastCoalProgressSeen: number; staleCoalBusyCycles: number; stale: boolean } {
  const prevSeen =
    typeof persisted.lastCoalProgressSeen === 'number' && Number.isFinite(persisted.lastCoalProgressSeen)
      ? persisted.lastCoalProgressSeen
      : effectiveCoal;
  let staleCycles = persisted.staleCoalBusyCycles ?? 0;

  if (!busyMiningCoal) {
    return {
      lastCoalProgressSeen: Math.max(prevSeen, effectiveCoal),
      staleCoalBusyCycles: 0,
      stale: false,
    };
  }

  if (effectiveCoal > prevSeen) {
    return {
      lastCoalProgressSeen: effectiveCoal,
      staleCoalBusyCycles: 0,
      stale: false,
    };
  }

  staleCycles += 1;
  return {
    lastCoalProgressSeen: prevSeen,
    staleCoalBusyCycles: staleCycles,
    stale: staleCycles >= STALE_COAL_BUSY_CYCLES,
  };
}

function computeFishCodBackoff(persisted: PersistedPlaybook): {
  active: boolean;
  until?: string;
  failures: number;
} {
  const failures = persisted.consecutiveFishCodFailures ?? 0;
  const until = persisted.fishCodBackoffUntil;
  if (!until) {
    return { active: false, failures };
  }
  const remaining = new Date(until).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return { active: false, failures };
  }
  return { active: true, until, failures };
}

function computeGatherGrace(
  persisted: PersistedPlaybook,
  stage: EarlyStageId,
): { active: boolean; skill?: string; resource?: string } {
  if (!persisted.lastGatherRestartAt) return { active: false };
  const elapsed = Date.now() - new Date(persisted.lastGatherRestartAt).getTime();
  if (elapsed > GATHER_GRACE_MS) return { active: false };
  if (stage === 'fish_cod' || stage === 'mine_coal') {
    return {
      active: true,
      skill: persisted.lastGatherSkill,
      resource: persisted.lastGatherResource,
    };
  }
  return { active: false };
}

/** Soft display estimate from busy cycles (never used for hard gates). */
function displayCoalEstimate(counts: PlaybookCounts): number {
  if (counts.coal >= COAL_MIN) return counts.coal;
  const estimate = Math.floor(counts.coalBusyCycles / 2.5);
  return Math.max(counts.coal, Math.min(COAL_MAX, estimate));
}

/** Soft display estimate from busy cycles (never used for hard gates). */
function displayCodEstimate(counts: PlaybookCounts): number {
  if (counts.rawCod >= COD_MIN) return counts.rawCod;
  const estimate = Math.floor(counts.codBusyCycles / 2.5);
  return Math.max(counts.rawCod, Math.min(COD_MAX, estimate));
}

/**
 * Hard coal gate: real playbook counter and/or inventory sync only.
 * Busy-cycle estimates must NOT satisfy this.
 */
export function coalTargetMet(counts: PlaybookCounts): boolean {
  return counts.coal >= COAL_MIN;
}

/** Hard fish gate: rawCod counter / inventory sync only (not codBusyCycles). */
export function fishTargetMet(counts: PlaybookCounts): boolean {
  return counts.rawCod >= COD_MIN;
}

/** Hard cook gate: cookedCod counter / inventory sync only. */
export function cookTargetMet(counts: PlaybookCounts): boolean {
  return counts.cookedCod >= COOK_MIN;
}

function huntBattleCount(counts: PlaybookCounts): number {
  return counts.huntBattles ?? counts.rabbitHunts ?? 0;
}

/** Hard hunt gate: successful hunt/battle outcome counter only. */
export function huntTargetMet(counts: PlaybookCounts): boolean {
  return huntBattleCount(counts) >= HUNT_MIN;
}

/**
 * Opportunistic pets maintenance: soft-prefer / interrupt manage_pets even while busy
 * (claim/feed/battle/sleep). Does not gate the batch. Equip is handled separately when idle.
 * Fires once per batch (petManages===0) on every Nth completed cycle.
 */
export function shouldInjectAsyncPets(
  counts: PlaybookCounts,
  _snapshot: GameSnapshot,
  everyN: number = PETS_ASYNC_EVERY_N_CYCLES,
): boolean {
  if (counts.petManages >= 1) return false;
  const n = everyN > 0 ? everyN : 1;
  // Cycle 0 (first run) and every Nth completed cycle — OK while gatherBusy.
  return counts.batchCycles % n === 0;
}

function isCharacterBusy(snapshot: GameSnapshot): boolean {
  return Boolean(
    snapshot.currentAction?.busy || snapshot.flags.gatherBusy || snapshot.flags.inBattle,
  );
}

/**
 * Idle-only equip tip: after maintenance (possibly while busy without Equip),
 * soft-prefer equip_pet once (petManages===1) so the character gets the pet boost.
 * equip_pet outcome bumps petManages so this does not spam every idle cycle.
 */
export function shouldInjectEquipPet(
  counts: PlaybookCounts,
  snapshot: GameSnapshot,
  everyN: number = PETS_ASYNC_EVERY_N_CYCLES,
): boolean {
  if (isCharacterBusy(snapshot)) return false;
  // Exactly one maintain tick already counted — tip equip before it advances further.
  if (counts.petManages !== 1) return false;
  const n = everyN > 0 ? everyN : 1;
  return counts.batchCycles % n === 0;
}

export function hasTurnInReady(snapshot: GameSnapshot): boolean {
  return snapshot.acceptedQuests.some((q) => q.canTurnIn);
}

export function hasPendingQuestAccept(snapshot: GameSnapshot): boolean {
  return snapshot.pendingQuests.length > 0;
}

export function questsAvailableForEarlyGold(snapshot: GameSnapshot): boolean {
  return hasTurnInReady(snapshot) || hasPendingQuestAccept(snapshot);
}

/** Skip sell_half when bait is already affordable or quests can fund bait instead of market sell. */
export function canSkipSellHalfForQuestFunding(snapshot: GameSnapshot): boolean {
  if ((snapshot.gold ?? 0) >= BAIT_GOLD_COST) return true;
  return questsAvailableForEarlyGold(snapshot);
}

function buildPreferredActions(
  meta: ReturnType<typeof stageMeta>,
  snapshot: GameSnapshot,
): AutopilotAction[] {
  const preferred = [...meta.preferred];
  if (!questsAvailableForEarlyGold(snapshot)) {
    return preferred;
  }

  const questActions: AutopilotAction[] = [];
  if (hasTurnInReady(snapshot)) questActions.push('quest_turnin');
  if (hasPendingQuestAccept(snapshot)) questActions.push('quest_talk_accept');

  const nonSell = preferred.filter((a) => !EARLY_GOLD_SELL_SET.has(a));
  const sellPreferred = preferred.filter((a) => EARLY_GOLD_SELL_SET.has(a));

  return [...questActions, ...nonSell, ...sellPreferred];
}

function deriveStage(
  counts: PlaybookCounts,
  snapshot: GameSnapshot,
  persisted: EarlyStageId,
  baitOwned: boolean,
): EarlyStageId {
  if (persisted === 'complete') return 'complete';

  const hasBait = trustHasBait(snapshot, baitOwned, persisted);
  const idx = STAGE_ORDER.indexOf(persisted);

  // Strict sequential hard gates by real counts (busy-cycles never advance stages).
  if (!coalTargetMet(counts)) {
    return 'mine_coal';
  }
  if (counts.sells < 1 && (persisted === 'mine_coal' || persisted === 'sell_half')) {
    // After coal target, sell for bait gold unless quests / wallet already fund bait.
    if (canSkipSellHalfForQuestFunding(snapshot)) return 'buy_bait';
    return 'sell_half';
  }
  if (!hasBait && (persisted === 'sell_half' || persisted === 'buy_bait' || idx <= STAGE_ORDER.indexOf('buy_bait'))) {
    return 'buy_bait';
  }
  if (!fishTargetMet(counts)) {
    if (hasBait || idx >= STAGE_ORDER.indexOf('buy_bait')) return 'fish_cod';
  }
  if (fishTargetMet(counts) && !cookTargetMet(counts)) {
    if (idx >= STAGE_ORDER.indexOf('fish_cod') || hasBait) return 'cook_cod';
  }
  if (cookTargetMet(counts) && !huntTargetMet(counts) && idx >= STAGE_ORDER.indexOf('cook_cod')) {
    return 'hunt_battle_batch';
  }
  // Pets are async — never a sequential stage after hunt.
  // First-cycle map peek after hunt target; batch reset happens in evaluatePlaybook.
  if (
    huntTargetMet(counts) &&
    counts.mapPeeks < 1 &&
    counts.batchCycles === 0 &&
    idx >= STAGE_ORDER.indexOf('hunt_battle_batch')
  ) {
    return 'explore_map';
  }

  // Fall through: keep persisted stage if still sensible.
  // Legacy stages (removed from STAGE_ORDER) → treat as hunt for loop logic.
  if (persisted === 'manage_pets' || persisted === 'sell_extras') {
    return 'hunt_battle_batch';
  }
  return persisted === 'mine_coal' && coalTargetMet(counts) ? 'sell_half' : persisted;
}

function stageMeta(stage: EarlyStageId, baitOwned = false): {
  goal: string;
  preferred: AutopilotAction[];
  deprioritized: AutopilotAction[];
  interrupt: AutopilotAction[];
  hint: string;
} {
  switch (stage) {
    case 'mine_coal':
      return {
        goal: `Mine ${COAL_MIN}–${COAL_MAX} Coal Ore`,
        preferred: ['mine_coal', 'continue_current'],
        deprioritized: [
          'gather_oak',
          'gather_yew',
          'hunt_battle',
          'explore_map',
          'fish_cod',
          'cook_cod',
        ],
        interrupt: ['mine_coal'],
        hint:
          `EARLY PLAYBOOK stage mine_coal: coal first before fishing — interrupt Oak/Yew and mine Coal Ore until ~${COAL_MIN}–${COAL_MAX}. Prefer mine_coal; deprioritize fish_cod until coal target met.`,
      };
    case 'sell_half':
      return {
        goal: 'Sell roughly half the coal / junk carefully (small batches; keep cook fuel)',
        preferred: ['sell_junk_for_gold', 'market_sell_half', 'sell_junk'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal'],
        interrupt: ['sell_junk_for_gold', 'market_sell_half', 'sell_junk'],
        hint:
          'EARLY PLAYBOOK stage sell_half: missions-first — quest_turnin / quest_talk_accept before market sell when quests are available. Sell ~half excess mats only as fallback. Keep enough Coal for cooking. Do not membership-spend.',
      };
    case 'buy_bait':
      return {
        goal: 'Buy Cheap Bait at Melriel General Goods (gold only)',
        // If bait is already trusted (sticky), never prefer/interrupt into buy_bait.
        preferred: baitOwned ? ['fish_cod', 'continue_current'] : ['buy_bait'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal', ...(baitOwned ? (['buy_bait'] as AutopilotAction[]) : [])],
        interrupt: baitOwned ? ['fish_cod'] : ['buy_bait'],
        hint: baitOwned
          ? 'EARLY PLAYBOOK stage buy_bait but baitOwned=true — skip repurchase; fish Cod instead.'
          : 'EARLY PLAYBOOK stage buy_bait: buy Cheap Bait with gold only (Purchase for N). No tokens/membership.',
      };
    case 'fish_cod':
      return {
        goal: `Fish ${COD_MIN}–${COD_MAX} Raw Cod`,
        // Once bait is trusted, never prefer buy_bait (HttpJev was looping purchases).
        preferred: baitOwned
          ? ['fish_cod', 'continue_current']
          : ['fish_cod', 'buy_bait', 'continue_current'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal', ...(baitOwned ? (['buy_bait'] as AutopilotAction[]) : [])],
        interrupt: ['fish_cod'],
        hint: baitOwned
          ? 'EARLY PLAYBOOK stage fish_cod: bait already owned — interrupt non-Cod gather into fish_cod. Do NOT buy more bait.'
          : 'EARLY PLAYBOOK stage fish_cod: fish Cod. If bait missing buy once then fish. Prefer fish_cod over continue_current when not on Cod.',
      };
    case 'cook_cod':
      return {
        goal: `Cook ~${COOK_MIN} Cod into Cooked Cod (battle food + pet feed)`,
        preferred: ['cook_cod'],
        deprioritized: ['gather_oak', 'gather_yew'],
        interrupt: ['cook_cod'],
        hint: `EARLY PLAYBOOK stage cook_cod: cook Cod with Coal until ~${COOK_MIN} Cooked Cod for battles/pets.`,
      };
    case 'sell_extras':
      return {
        goal: 'Sell extras carefully; keep Cod/Cooked Cod for battles',
        preferred: ['sell_junk_for_gold', 'market_sell_half', 'sell_junk'],
        deprioritized: ['gather_oak', 'gather_yew'],
        interrupt: ['sell_junk_for_gold', 'market_sell_half', 'sell_junk'],
        hint:
          'EARLY PLAYBOOK stage sell_extras: missions-first — quest_turnin / quest_talk_accept before market sell when quests are available. Sell junk/extras only as fallback. Never sell all Cooked Cod / Cod needed for fights.',
      };
    case 'hunt_battle_batch':
      return {
        goal: `Hunt/battle ~${HUNT_MIN} times using Cooked Cod (pre-battle FOOD Add)`,
        preferred: ['hunt_battle_batch', 'hunt_battle'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal'],
        interrupt: ['hunt_battle_batch', 'hunt_battle'],
        hint:
          `EARLY PLAYBOOK stage hunt_battle_batch: hunt and battle any ready enemy until ~${HUNT_MIN} successes (huntBattles counter — prefer Rabbit when present, battle any ready enemy). Ensure Cooked Cod via FOOD Add. Respect huntFoundCap.`,
      };
    case 'manage_pets':
      // Legacy stage id kept for logging only — not in STAGE_ORDER; pets inject async instead.
      return {
        goal: 'Manage pets (async): claim, feed (avoid wasteful Max), battle/sleep for stamina',
        preferred: ['manage_pets'],
        deprioritized: ['gather_oak', 'gather_yew'],
        interrupt: ['manage_pets'],
        hint:
          'EARLY PLAYBOOK manage_pets (async interrupt): open /pets — claim finished work, feed injured pets carefully, send idle pets to battle or sleep. Does not gate the coal→fish→cook→hunt batch.',
      };
    case 'explore_map':
      return {
        goal: 'Peek / explore the Map and register discovery',
        preferred: ['explore_map'],
        deprioritized: ['gather_oak', 'gather_yew'],
        interrupt: ['explore_map'],
        hint: 'EARLY PLAYBOOK stage explore_map: open the map, peek zones, register discovery. Read-only exploration.',
      };
    case 'complete':
    default:
      return {
        goal: 'Early systems playbook complete — resume progressive forever loop',
        preferred: [],
        deprioritized: [],
        interrupt: [],
        hint: 'EARLY PLAYBOOK complete. Expand actions via discovery; Jev chooses freely among progressive loops.',
      };
  }
}

/** Build playbook progress for this tick; persists stage counters. */
export function evaluatePlaybook(
  snapshot: GameSnapshot,
  _context?: AutopilotContext,
): PlaybookProgress {
  const enabled = playbookEnabled();
  if (!enabled) {
    return {
      enabled: false,
      stage: 'complete',
      stageIndex: STAGE_ORDER.indexOf('complete'),
      stageGoal: 'disabled',
      preferredActions: [],
      deprioritizedActions: [],
      interruptActions: [],
      counts: emptyCounts(),
      baitOwned: false,
      targets: {
        coalMin: COAL_MIN,
        coalMax: COAL_MAX,
        codMin: COD_MIN,
        codMax: COD_MAX,
        cookMin: COOK_MIN,
        huntMin: HUNT_MIN,
      },
      curriculumHint: 'Early playbook disabled (EARLY_PLAYBOOK=false).',
      complete: true,
      gatherGraceActive: false,
      fishCodBackoffActive: false,
      consecutiveFishCodFailures: 0,
      staleCoalGather: false,
      staleCoalBusyCycles: 0,
    };
  }

  const persisted = loadPersisted();
  let counts = syncCountsFromSnapshot(persisted.counts, snapshot);
  // Recover pre-baitOwned runs that already advanced past buy_bait after purchases.
  let baitOwned = Boolean(persisted.baitOwned);
  if (!baitOwned && STAGE_ORDER.indexOf(persisted.stage) > STAGE_ORDER.indexOf('buy_bait')) {
    baitOwned = true;
  }
  if (!baitOwned && (snapshot.flags.hasBait || invCount(snapshot, ['Cheap Bait', 'Bait']) > 0)) {
    baitOwned = true;
  }

  // Legacy stages removed from STAGE_ORDER; normalize before gates.
  let persistedStage = normalizeEarlyStageId(persisted.stage);
  if (persistedStage === 'manage_pets') {
    persistedStage = 'hunt_battle_batch';
  }
  if (persistedStage === 'sell_extras' && cookTargetMet(counts)) {
    persistedStage = 'hunt_battle_batch';
  }

  let stage = deriveStage(counts, snapshot, persistedStage, baitOwned);
  const coalMet = coalTargetMet(counts);
  const fishMet = fishTargetMet(counts);
  const cookMet = cookTargetMet(counts);
  const huntMet = huntTargetMet(counts);
  // Treat legacy stages (removed from STAGE_ORDER) for snap-back comparisons.
  const persistedIdx =
    persisted.stage === 'manage_pets'
      ? STAGE_ORDER.indexOf('explore_map')
      : persisted.stage === 'sell_extras' && cookMet
        ? STAGE_ORDER.indexOf('hunt_battle_batch')
        : STAGE_ORDER.indexOf(persistedStage);

  // Snap back to the first unmet hard-gate stage (real counts only).
  // Busy-cycle estimates must never keep a bot ahead of unfinished prior stages.
  let snapBackReason: string | undefined;
  if (!coalMet) {
    if (persistedIdx > STAGE_ORDER.indexOf('mine_coal')) {
      snapBackReason =
        `coal gate: snapped back from ${persisted.stage} to mine_coal ` +
        `(coal=${counts.coal}/${COAL_MIN}, busyCycles=${counts.coalBusyCycles} ignored for gate)`;
    }
    stage = 'mine_coal';
  } else if (!fishMet && persistedIdx > STAGE_ORDER.indexOf('fish_cod')) {
    if (!trustHasBait(snapshot, baitOwned, persisted.stage)) {
      stage = counts.sells < 1 && !canSkipSellHalfForQuestFunding(snapshot) ? 'sell_half' : 'buy_bait';
      snapBackReason =
        `fish gate: snapped back from ${persisted.stage} toward bait/fish ` +
        `(rawCod=${counts.rawCod}/${COD_MIN}; bait not trusted)`;
    } else {
      snapBackReason =
        `fish gate: snapped back from ${persisted.stage} to fish_cod ` +
        `(rawCod=${counts.rawCod}/${COD_MIN}, busyCycles=${counts.codBusyCycles} ignored for gate)`;
      stage = 'fish_cod';
      baitOwned = true;
    }
  } else if (!cookMet && persistedIdx > STAGE_ORDER.indexOf('cook_cod')) {
    snapBackReason =
      `cook gate: snapped back from ${persisted.stage} to cook_cod ` +
      `(cookedCod=${counts.cookedCod}/${COOK_MIN})`;
    stage = 'cook_cod';
  } else if (!huntMet && persistedIdx > STAGE_ORDER.indexOf('hunt_battle_batch')) {
    snapBackReason =
      `hunt gate: snapped back from ${persisted.stage} to hunt_battle_batch ` +
      `(huntBattles=${huntBattleCount(counts)}/${HUNT_MIN})`;
    stage = 'hunt_battle_batch';
  } else {
    // Monotonic advance: never go backwards once prior hard gates are met.
    const nextIdx = STAGE_ORDER.indexOf(stage);
    if (nextIdx < persistedIdx) stage = persistedStage;
  }

  // Auto-advance within sequence when real targets are met (no busy-cycle shortcuts).
  if (stage === 'mine_coal' && coalMet) {
    stage = 'sell_half';
  }
  if (
    stage === 'sell_half' &&
    (counts.sells >= 1 || canSkipSellHalfForQuestFunding(snapshot))
  ) {
    stage = 'buy_bait';
  }
  if (stage === 'buy_bait' && trustHasBait(snapshot, baitOwned, stage)) {
    stage = 'fish_cod';
    baitOwned = true;
  }
  if (stage === 'fish_cod' && fishMet) {
    stage = 'cook_cod';
  }
  if (stage === 'cook_cod' && cookMet) stage = 'hunt_battle_batch';
  // Legacy: persisted sell_extras (removed from STAGE_ORDER) → hunt when cook met.
  if (stage === 'sell_extras' && cookMet && !huntMet) {
    stage = 'hunt_battle_batch';
  }
  // Hunt target met → loop batch (pets are async; never block on manage_pets).
  if (stage === 'hunt_battle_batch' && huntMet) {
    if (counts.mapPeeks < 1 && counts.batchCycles === 0) {
      stage = 'explore_map';
    } else {
      counts = resetBatchResourceCounts(counts);
      stage = 'mine_coal';
    }
  }
  // Legacy: if somehow still on manage_pets, same loop behavior (no petManages gate).
  if (stage === 'manage_pets') {
    if (!huntMet) {
      stage = 'hunt_battle_batch';
    } else if (counts.mapPeeks < 1 && counts.batchCycles === 0) {
      stage = 'explore_map';
    } else {
      counts = resetBatchResourceCounts(counts);
      stage = 'mine_coal';
    }
  }
  if (stage === 'explore_map' && counts.mapPeeks >= 1) {
    counts = resetBatchResourceCounts(counts);
    stage = 'mine_coal';
  }

  const busyMiningCoal = isBusyMiningCoal(snapshot);
  const staleTrack = updateStaleCoalBusyTracking(persisted, counts.coal, busyMiningCoal);
  const staleCoalGather = staleTrack.stale;
  if (staleCoalGather) {
    console.warn(
      `[playbook] stale coal gather: busy mining coal for ${staleTrack.staleCoalBusyCycles} flat cycles ` +
        `(coal=${counts.coal}, lastSeen=${staleTrack.lastCoalProgressSeen}) — force re-mine_coal`,
    );
  }

  const grace = computeGatherGrace(persisted, stage);
  const fishBackoff = computeFishCodBackoff(persisted);
  if (grace.active && stage === 'fish_cod') {
    const resource = snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '';
    const creditedFromSnapshot =
      /\bcod\b/i.test(resource) && snapshot.currentAction?.skill === 'fishing';
    if (!creditedFromSnapshot) {
      counts = { ...counts, codBusyCycles: counts.codBusyCycles + 1 };
    }
  }

  const meta = stageMeta(stage, baitOwned);
  const questCurriculum = evaluateQuestCurriculum(snapshot);
  const complete = stage === 'complete';
  const backoffActive = stage === 'fish_cod' && fishBackoff.active;
  let preferredActions = backoffActive
    ? [...FISH_COD_BACKOFF_FALLBACKS]
    : buildPreferredActions(meta, snapshot);
  let deprioritizedActions = [...meta.deprioritized];
  let interruptActions = backoffActive
    ? meta.interrupt.filter((a) => a !== 'fish_cod')
    : [...meta.interrupt];

  const baitStock =
    (snapshot.inventory['Cheap Bait'] ?? 0) + (snapshot.inventory['Bait'] ?? 0);
  // Trust recent purchase during cooldown — scrape often undercounts after buy_bait.
  const needsBaitRestockNow = shouldPreferBaitRestock(
    stage,
    baitStock,
    persisted.lastBaitPurchaseAt,
  );
  if (needsBaitRestockNow) {
    preferredActions = [
      'buy_bait',
      ...preferredActions.filter((a) => a !== 'buy_bait' && a !== 'fish_cod'),
    ];
    interruptActions = [
      'buy_bait',
      ...interruptActions.filter((a) => a !== 'buy_bait' && a !== 'fish_cod'),
    ];
    if (!deprioritizedActions.includes('fish_cod')) deprioritizedActions.push('fish_cod');
    if (!deprioritizedActions.includes('craft_if_ready')) {
      deprioritizedActions.push('craft_if_ready');
    }
  }

  if (questCurriculum.hasEasyFinishableQuest) {
    deprioritizedActions = deprioritizedActions.filter(
      (a) => !questCurriculum.preferredActions.includes(a),
    );
    deprioritizedActions = [
      ...new Set([...deprioritizedActions, ...questCurriculum.deprioritizedActions]),
    ];
    for (const action of questCurriculum.preferredActions) {
      if (!preferredActions.includes(action)) preferredActions.unshift(action);
    }
    for (const action of questCurriculum.interruptActions) {
      if (!interruptActions.includes(action)) interruptActions.push(action);
    }
  }

  // Async pets: soft-prefer / interrupt without changing stage or gating the batch.
  // Maintenance OK while busy; when busy, unshift so stub/Jev can pick over continue_current.
  const asyncPets = shouldInjectAsyncPets(counts, snapshot);
  const busyNow = isCharacterBusy(snapshot);
  if (asyncPets) {
    if (busyNow) {
      preferredActions = [
        'manage_pets',
        ...preferredActions.filter((a) => a !== 'manage_pets'),
      ];
    } else if (!preferredActions.includes('manage_pets')) {
      preferredActions.push('manage_pets');
    }
    if (!interruptActions.includes('manage_pets')) interruptActions.push('manage_pets');
    deprioritizedActions = deprioritizedActions.filter((a) => a !== 'manage_pets');
  }

  // Idle-only equip after a busy-time (or prior) maintain tick without Equip.
  const asyncEquip = shouldInjectEquipPet(counts, snapshot);
  if (asyncEquip) {
    if (!preferredActions.includes('equip_pet')) preferredActions.push('equip_pet');
    if (!interruptActions.includes('equip_pet')) interruptActions.push('equip_pet');
    deprioritizedActions = deprioritizedActions.filter((a) => a !== 'equip_pet');
  }

  // Stale coal busy: drop continue_current preference; hard-prefer mine_coal interrupt restart.
  if (staleCoalGather && (stage === 'mine_coal' || !coalTargetMet(counts))) {
    preferredActions = [
      'mine_coal',
      ...preferredActions.filter((a) => a !== 'mine_coal' && a !== 'continue_current'),
    ];
    if (!interruptActions.includes('mine_coal')) interruptActions.unshift('mine_coal');
    if (!deprioritizedActions.includes('continue_current')) {
      deprioritizedActions.push('continue_current');
    }
  }

  const baitPurchaseRecent = recentBaitPurchase(persisted.lastBaitPurchaseAt);
  let curriculumHint = snapBackReason
    ? `EARLY PLAYBOOK ${snapBackReason}. Strict real-count batch gates.`
    : needsBaitRestockNow
    ? `EARLY PLAYBOOK fish_cod needs bait restock (Cheap Bait=${baitStock} < 15) — choose buy_bait before fish_cod.`
    : baitPurchaseRecent && stage === 'fish_cod' && baitStock < 15
      ? `EARLY PLAYBOOK fish_cod: scrape Cheap Bait=${baitStock} < 15 but recent buy_bait still in cooldown — trust purchased stock; do NOT repurchase.`
    : backoffActive
      ? `EARLY PLAYBOOK fish_cod backoff (${fishBackoff.failures} failures) until ${fishBackoff.until ?? 'cooldown'} — ` +
        `prefer ${FISH_COD_BACKOFF_FALLBACKS.join('/')} instead of hammering fish_cod. baitOwned stays true.`
      : meta.hint;
  if (questCurriculum.hint) {
    curriculumHint = `${curriculumHint} ${questCurriculum.hint}`.trim();
  }
  if (asyncPets) {
    curriculumHint = (
      `${curriculumHint} EARLY PLAYBOOK pets async: soft-prefer manage_pets ` +
      `(every ${PETS_ASYNC_EVERY_N_CYCLES} cycle(s); maintenance OK while busy; does not gate batch).`
    ).trim();
  }
  if (asyncEquip) {
    curriculumHint = (
      `${curriculumHint} EARLY PLAYBOOK pets equip: soft-prefer equip_pet while idle for boost.`
    ).trim();
  }
  if (staleCoalGather) {
    curriculumHint = (
      `${curriculumHint} EARLY PLAYBOOK stale coal gather: inventory/playbook coal flat while busy mining — ` +
      `interrupt and re-mine_coal (Stop + Start batch) instead of endless continue_current.`
    ).trim();
  }

  savePersisted({
    version: 1,
    stage,
    counts,
    baitOwned,
    lastBaitPurchaseAt: persisted.lastBaitPurchaseAt,
    completedAt: complete ? persisted.completedAt ?? new Date().toISOString() : undefined,
    lastGatherRestartAt: persisted.lastGatherRestartAt,
    lastGatherSkill: persisted.lastGatherSkill,
    lastGatherResource: persisted.lastGatherResource,
    consecutiveFishCodFailures: fishBackoff.failures,
    fishCodBackoffUntil: fishBackoff.active ? fishBackoff.until : undefined,
    lastCoalProgressSeen: staleTrack.lastCoalProgressSeen,
    staleCoalBusyCycles: staleTrack.staleCoalBusyCycles,
  });

  return {
    enabled: true,
    stage,
    stageIndex: STAGE_ORDER.indexOf(stage),
    stageGoal: meta.goal,
    preferredActions,
    deprioritizedActions,
    interruptActions,
    counts,
    baitOwned,
    lastBaitPurchaseAt: persisted.lastBaitPurchaseAt,
    targets: {
      coalMin: COAL_MIN,
      coalMax: COAL_MAX,
      codMin: COD_MIN,
      codMax: COD_MAX,
      cookMin: COOK_MIN,
      huntMin: HUNT_MIN,
    },
    curriculumHint,
    complete,
    gatherGraceActive: grace.active,
    gatherGraceSkill: grace.skill,
    gatherGraceResource: grace.resource,
    fishCodBackoffActive: backoffActive,
    fishCodBackoffUntil: fishBackoff.until,
    consecutiveFishCodFailures: fishBackoff.failures,
    staleCoalGather,
    staleCoalBusyCycles: staleTrack.staleCoalBusyCycles,
    questCurriculum,
  };
}

/** Record action outcomes that advance counters (sells, hunts, map peeks). */
export function notePlaybookOutcome(action: AutopilotAction, outcome: string): void {
  if (!playbookEnabled()) return;
  const persisted = loadPersisted();
  const counts = { ...persisted.counts };
  let stage = persisted.stage;

  if (action === 'market_sell_half' || action === 'sell_junk' || action === 'sell_junk_for_gold') {
    if (/sold|sell/i.test(outcome) && !/no_action|failed/i.test(outcome)) {
      counts.sells += 1;
    }
  }
  if (action === 'hunt_battle_batch' || action === 'hunt_rabbits' || action === 'hunt_battle') {
    if (/battle:|hunt_started|enemy_selected/i.test(outcome)) {
      counts.huntBattles += 1;
    }
  }
  if (action === 'explore_map') {
    if (!/failed/i.test(outcome)) counts.mapPeeks += 1;
  }
  if (action === 'manage_pets' || action === 'equip_pet') {
    // Async counter only — does not gate batch completion / loop to mine_coal.
    // no_pets still counts as a successful opportunistic tick (nothing to manage).
    // equip_pet success bumps petManages so shouldInjectEquipPet (===1) fires once.
    if (/no_pets/i.test(outcome) || (!/failed|no_action/i.test(outcome) && outcome.trim())) {
      counts.petManages += 1;
    }
  }
  let baitOwned = Boolean(persisted.baitOwned);
  let lastBaitPurchaseAt = persisted.lastBaitPurchaseAt;
  let lastGatherRestartAt = persisted.lastGatherRestartAt;
  let lastGatherSkill = persisted.lastGatherSkill;
  let lastGatherResource = persisted.lastGatherResource;
  let consecutiveFishCodFailures = persisted.consecutiveFishCodFailures ?? 0;
  let fishCodBackoffUntil = persisted.fishCodBackoffUntil;
  if (action === 'buy_bait' && /purchased/i.test(outcome)) {
    baitOwned = true;
    lastBaitPurchaseAt = new Date().toISOString();
    if (stage === 'buy_bait' || STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf('buy_bait')) {
      // Coal first: only advance to fish_cod once coal target is met.
      stage = coalTargetMet(counts) ? 'fish_cod' : 'mine_coal';
    }
  }
  if (action === 'fish_cod' && /failed|fishing_start_failed|missing_requirement/i.test(outcome)) {
    if (/failed|fishing_start_failed/i.test(outcome)) {
      consecutiveFishCodFailures += 1;
      if (consecutiveFishCodFailures >= FISH_COD_FAILURE_THRESHOLD) {
        fishCodBackoffUntil = new Date(Date.now() + FISH_COD_BACKOFF_MS).toISOString();
        console.warn(
          `[playbook] fish_cod start failed ${consecutiveFishCodFailures}x — backoff until ${fishCodBackoffUntil} ` +
            '(prefer mine_coal/cook_cod/sell_junk_for_gold/continue_current; baitOwned stays true)',
        );
      }
    }
    // Do NOT clear baitOwned or retreat to buy_bait. Inventory scrape / Start UI / captcha
    // often false-flags missing bait while Cheap Bait is already owned.
    if (baitOwned || STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf('buy_bait')) {
      console.warn(
        '[playbook] fish_cod missing_requirement with bait trusted — treating as fishing-start failure ' +
          '(UI/captcha/Start/quantity), NOT missing bait. baitOwned stays true.',
      );
    } else {
      console.warn(
        '[playbook] fish_cod missing_requirement before bait trust — staying on current stage; ' +
          'will not auto-retreat to buy_bait from this signal alone.',
      );
    }
    // Keep stage on fish_cod when we were fishing; leave gather grace alone so retries can settle.
    if (STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf('fish_cod')) {
      stage = 'fish_cod';
    }
  }
  if (action === 'fish_cod' && /restarted|already_busy/i.test(outcome)) {
    consecutiveFishCodFailures = 0;
    fishCodBackoffUntil = undefined;
    lastGatherRestartAt = new Date().toISOString();
    lastGatherSkill = 'fishing';
    lastGatherResource = 'Cod';
  }
  if (action === 'cook_cod' && /restarted|already_busy|kept_current/i.test(outcome)) {
    counts.cookedCod = Math.max(counts.cookedCod, counts.cookedCod + 1);
  }
  let lastCoalProgressSeen = persisted.lastCoalProgressSeen;
  let staleCoalBusyCycles = persisted.staleCoalBusyCycles ?? 0;
  if (action === 'mine_coal' && /restarted|already_busy/i.test(outcome)) {
    lastGatherRestartAt = new Date().toISOString();
    lastGatherSkill = 'mining';
    lastGatherResource = 'Coal Ore';
    if (/restarted/i.test(outcome)) {
      // Fresh start — clear stale flat counter so we re-measure production.
      staleCoalBusyCycles = 0;
    }
    if (stage === 'mine_coal') {
      /* stay */
    }
  }

  savePersisted({
    version: 1,
    stage,
    counts,
    baitOwned,
    lastBaitPurchaseAt,
    lastGatherRestartAt,
    lastGatherSkill,
    lastGatherResource,
    consecutiveFishCodFailures,
    fishCodBackoffUntil,
    lastCoalProgressSeen,
    staleCoalBusyCycles,
  });
}


/** Combat actions for the hunt batch stage (canonical + legacy alias + single-round). */
export const HUNT_COMBAT_ACTIONS = ['hunt_battle_batch', 'hunt_rabbits', 'hunt_battle'] as const;
export type HuntCombatAction = (typeof HUNT_COMBAT_ACTIONS)[number];

export function isHuntCombatAction(action: string): action is HuntCombatAction {
  return (HUNT_COMBAT_ACTIONS as readonly string[]).includes(action);
}

/**
 * Active hunt / battle must finish even when cook-before-hunt would otherwise
 * hide hunt_battle_batch — otherwise Hunt More orphans a running hunt while we cook.
 */
export function mustFinishActiveHunt(snapshot: GameSnapshot): boolean {
  if (snapshot.flags.inBattle) return true;
  if (snapshot.combatPhase === 'hunt' || snapshot.combatPhase === 'enemy_select') return true;
  if (shouldHardStopHunt(snapshot.totalEnemiesFound, snapshot.combatLevel, snapshot.totalLevel)) {
    return true;
  }
  return false;
}

/**
 * Filter/prioritize allowed actions using playbook curriculum.
 * Does NOT replace Jev — only shapes the choice set and hints.
 */
export function filterAllowedByPlaybook(
  allowed: AutopilotAction[],
  snapshot: GameSnapshot,
  playbook: PlaybookProgress,
): AutopilotAction[] {
  if (!playbook.enabled || playbook.complete) return allowed;

  const resource = snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '';
  const busy = Boolean(snapshot.currentAction?.busy || snapshot.flags.gatherBusy);
  const baitTrusted = playbook.baitOwned || snapshot.flags.hasBait;
  const fishBackoff =
    playbook.stage === 'fish_cod' &&
    (playbook.fishCodBackoffActive ||
      (playbook.fishCodBackoffUntil &&
        Date.now() < new Date(playbook.fishCodBackoffUntil).getTime()));

  let next = allowed.filter((a) => !playbook.deprioritizedActions.includes(a));

  // Strict sequential gates: drop later-stage actions while earlier real targets unmet.
  const coalIncomplete = !coalTargetMet(playbook.counts);
  const fishIncomplete = !fishTargetMet(playbook.counts);
  const cookIncomplete = !cookTargetMet(playbook.counts);
  const cookBeforeHunt = needsCookBeforeHunt(snapshot.inventory, playbook.targets.cookMin);
  const finishHunt = mustFinishActiveHunt(snapshot);
  if (finishHunt) {
    // Over-cap / active hunt wins over cook gates — stop+battle before cooking.
    for (const id of HUNT_COMBAT_ACTIONS) {
      if (allowed.includes(id) && !next.includes(id)) next.push(id);
    }
    next = next.filter((a) => a !== 'cook_cod');
  } else if (coalIncomplete || playbook.stage === 'mine_coal') {
    next = next.filter(
      (a) => a !== 'fish_cod' && a !== 'cook_cod' && !isHuntCombatAction(a),
    );
    if (allowed.includes('mine_coal') && !next.includes('mine_coal')) {
      next.push('mine_coal');
    }
  } else if (fishIncomplete || playbook.stage === 'fish_cod') {
    next = next.filter((a) => a !== 'cook_cod' && !isHuntCombatAction(a));
  } else if (cookIncomplete || playbook.stage === 'cook_cod') {
    next = next.filter((a) => !isHuntCombatAction(a));
  } else if (cookBeforeHunt) {
    // Cook target may already be met while the character ate the stack. Cook again
    // before the next hunt/battle.
    next = next.filter((a) => !isHuntCombatAction(a));
    if (allowed.includes('cook_cod') && !next.includes('cook_cod')) next.push('cook_cod');
  }

  if (fishBackoff) {
    next = next.filter((a) => a !== 'fish_cod');
    for (const fallback of FISH_COD_BACKOFF_FALLBACKS) {
      if (allowed.includes(fallback) && !next.includes(fallback)) {
        next.push(fallback);
      }
    }
  }

  // NEVER allow buy_bait when bait is trusted, stage is past buy_bait, or purchase cooldown active —
  // even if stage was incorrectly reset to buy_bait or inventory scrape is empty.
  // Exception: fish_cod with low Cheap Bait stock needs restock for the 100-fish batch,
  // but only after purchase cooldown expires (scrape often undercounts right after buy_bait).
  const baitCount =
    (snapshot.inventory['Cheap Bait'] ?? 0) + (snapshot.inventory['Bait'] ?? 0);
  const baitCooldown = recentBaitPurchase(playbook.lastBaitPurchaseAt);
  // Scrape <15 alone must not force restock while purchase cooldown is active.
  const needsBaitRestock = shouldPreferBaitRestock(
    playbook.stage,
    baitCount,
    playbook.lastBaitPurchaseAt,
  );
  const pastBuyBait = STAGE_ORDER.indexOf(playbook.stage) > STAGE_ORDER.indexOf('buy_bait');
  if (!needsBaitRestock && (baitTrusted || pastBuyBait || baitCooldown || playbook.baitOwned)) {
    next = next.filter((a) => a !== 'buy_bait');
  } else if (needsBaitRestock) {
    next = next.filter((a) => a !== 'fish_cod');
    if (allowed.includes('buy_bait') && !next.includes('buy_bait')) next.push('buy_bait');
    // Hard-prefer: drop craft spam while bait is the missing requirement.
    next = next.filter((a) => a !== 'craft_if_ready');
  }

  // Easy-complete pending quests (e.g. Hearth 150/150) should win over continue_current.
  if (
    busy &&
    allowed.includes('quest_talk_accept') &&
    hasEasyCompletePendingQuest(snapshot.pendingQuests)
  ) {
    next = next.filter((a) => a !== 'continue_current');
    if (!next.includes('quest_talk_accept')) {
      next.push('quest_talk_accept');
    }
  }

  // Pets maintenance may run while gatherBusy (equip_pet stays idle-only via isAllowed).
  if (busy && playbook.interruptActions.includes('manage_pets') && allowed.includes('manage_pets')) {
    if (!next.includes('manage_pets')) next.push('manage_pets');
  }

  // Stale coal busy: never keep polling continue_current — force mine_coal restart path.
  if (playbook.staleCoalGather && (coalIncomplete || playbook.stage === 'mine_coal')) {
    next = next.filter((a) => a !== 'continue_current');
    if (allowed.includes('mine_coal') && !next.includes('mine_coal')) {
      next.push('mine_coal');
    }
  }

  // While on a mismatched gather, drop continue_current so Jev can pick the stage action.
  const preferredGather = playbook.preferredActions.find((a) => GATHER_RESOURCE[a]);
  const questGather = playbook.questCurriculum?.interruptActions.find((a) => GATHER_RESOURCE[a]);
  const interruptGather = preferredGather ?? questGather;
  if (busy && interruptGather) {
    const want = GATHER_RESOURCE[interruptGather];
    const onPreferred = want?.test(resource) ?? false;
    if (!onPreferred) {
      next = next.filter((a) => a !== 'continue_current');
      const inject = new Set([
        ...playbook.interruptActions,
        ...(playbook.questCurriculum?.interruptActions ?? []),
      ]);
      for (const id of inject) {
        if (!finishHunt && cookBeforeHunt && isHuntCombatAction(id)) continue;
        if (!next.includes(id)) next.push(id);
      }
    }
  } else if (!busy) {
    for (const id of playbook.preferredActions) {
      if (!next.includes(id) && playbook.interruptActions.includes(id)) {
        // Preferred non-gather actions (sell/bait/map) get injected when not already allowed
        // only if they are in interrupt list — actual isAllowed still gated at registry for safety
        // except we already passed registry. Injecting here is for interrupt gathers mainly.
      }
    }
    for (const id of playbook.interruptActions) {
      if (fishBackoff && id === 'fish_cod') {
        continue;
      }
      if (
        playbook.gatherGraceActive &&
        playbook.stage === 'fish_cod' &&
        id === 'fish_cod'
      ) {
        continue;
      }
      if (
        id === 'buy_bait' &&
        !needsBaitRestock &&
        (baitTrusted || pastBuyBait || baitCooldown || playbook.baitOwned)
      ) {
        continue;
      }
      if (playbook.deprioritizedActions.includes(id)) {
        continue;
      }
      if (!finishHunt && cookBeforeHunt && isHuntCombatAction(id)) {
        continue;
      }
      if (finishHunt && id === 'cook_cod') {
        continue;
      }
      if (!next.includes(id) && ['mine_coal', 'fish_cod', 'cook_cod', 'market_sell_half', 'sell_junk_for_gold', 'explore_map', 'hunt_battle_batch', 'manage_pets', 'equip_pet', 'buy_bait', 'sell_junk'].includes(id)) {
        next.push(id);
      }
    }
  }

  const questsAvailable = questsAvailableForEarlyGold(snapshot);
  const questCurriculum = playbook.questCurriculum;
  if (questsAvailable) {
    if (hasTurnInReady(snapshot) && allowed.includes('quest_turnin') && !next.includes('quest_turnin')) {
      next.push('quest_turnin');
    }
    if (
      hasPendingQuestAccept(snapshot) &&
      allowed.includes('quest_talk_accept') &&
      !next.includes('quest_talk_accept')
    ) {
      next.push('quest_talk_accept');
    }
  }
  if (questCurriculum?.hasEasyFinishableQuest) {
    for (const action of questCurriculum.preferredActions) {
      if (allowed.includes(action) && !next.includes(action)) {
        next.push(action);
      }
    }
  }

  // Ensure idle remains available.
  if (!next.includes('idle') && allowed.includes('idle')) next.push('idle');
  if (finishHunt) {
    next = next.filter((a) => a !== 'cook_cod');
    for (const id of HUNT_COMBAT_ACTIONS) {
      if (allowed.includes(id) && !next.includes(id)) next.push(id);
    }
    next = [
      ...HUNT_COMBAT_ACTIONS.filter((id) => next.includes(id)),
      ...next.filter((a) => !isHuntCombatAction(a)),
    ];
  }
  if (next.length === 0) return allowed.includes('idle') ? ['idle'] : allowed;

  if (needsBaitRestock && next.includes('buy_bait')) {
    next = ['buy_bait', ...next.filter((a) => a !== 'buy_bait')];
  }

  if ((coalIncomplete || playbook.stage === 'mine_coal') && next.includes('mine_coal')) {
    next = ['mine_coal', ...next.filter((a) => a !== 'mine_coal')];
  }

  const preferred = new Set(playbook.preferredActions);
  const questPreferred = new Set(questCurriculum?.preferredActions ?? []);
  const missionSort = questsAvailable || Boolean(questCurriculum?.hasEasyFinishableQuest);
  const missionFirstTier = (action: AutopilotAction): number => {
    if (action === 'quest_turnin') return 0;
    if (action === 'quest_talk_accept') return 1;
    if (questPreferred.has(action) && (action.startsWith('gather_') || action === 'gather_oak')) return 2;
    const isSell = EARLY_GOLD_SELL_SET.has(action);
    if (preferred.has(action) && !isSell) return 3;
    if (!preferred.has(action) && !isSell && action !== 'fish_cod') return 4;
    if (missionSort && preferred.has(action) && isSell) return 5;
    if (action === 'fish_cod' && questCurriculum?.hasEasyFinishableQuest) return 7;
    if (isSell) return 6;
    return 4;
  };

  const preferredOrder = new Map(playbook.preferredActions.map((action, index) => [action, index]));
  const questOrder = new Map((questCurriculum?.preferredActions ?? []).map((action, index) => [action, index]));
  next.sort((a, b) => {
    if (missionSort) {
      const tierDiff = missionFirstTier(a) - missionFirstTier(b);
      if (tierDiff !== 0) return tierDiff;
    } else {
      const ap = preferred.has(a) ? 0 : 1;
      const bp = preferred.has(b) ? 0 : 1;
      if (ap !== bp) return ap - bp;
    }
    const aPref = questOrder.get(a) ?? preferredOrder.get(a) ?? 999;
    const bPref = questOrder.get(b) ?? preferredOrder.get(b) ?? 999;
    if (aPref !== bPref) return aPref - bPref;
    const aAllowed = allowed.indexOf(a);
    const bAllowed = allowed.indexOf(b);
    if (aAllowed !== -1 || bAllowed !== -1) {
      const aIdx = aAllowed === -1 ? 999 : aAllowed;
      const bIdx = bAllowed === -1 ? 999 : bAllowed;
      if (aIdx !== bIdx) return aIdx - bIdx;
    }
    return 0;
  });

  return next;
}

export function attachPlaybookToSnapshot(
  snapshot: GameSnapshot,
  playbook: PlaybookProgress,
): GameSnapshot {
  const hasBait =
    snapshot.flags.hasBait ||
    playbook.baitOwned ||
    STAGE_ORDER.indexOf(playbook.stage) > STAGE_ORDER.indexOf('buy_bait');
  return {
    ...snapshot,
    flags: {
      ...snapshot.flags,
      hasBait,
    },
    inventory:
      hasBait && (snapshot.inventory['Cheap Bait'] ?? 0) <= 0
        ? { ...snapshot.inventory, 'Cheap Bait': Math.max(1, snapshot.inventory['Cheap Bait'] ?? 0) }
        : snapshot.inventory,
    extensions: {
      ...snapshot.extensions,
      earlySystemsPlaybook: playbook,
      questCurriculum: playbook.questCurriculum,
    },
  };
}

export function getPlaybookFromSnapshot(snapshot: GameSnapshot): PlaybookProgress | undefined {
  const raw = snapshot.extensions?.earlySystemsPlaybook;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as PlaybookProgress;
}

export function formatPlaybookLogLine(playbook: PlaybookProgress): string {
  const c = playbook.counts;
  const softCoal = displayCoalEstimate(c);
  const softCod = displayCodEstimate(c);
  return (
    `stage=${playbook.stage} goal="${playbook.stageGoal}"` +
    ` coal=${c.coal}/${playbook.targets.coalMin} (busy=${c.coalBusyCycles}, soft~${softCoal})` +
    ` cod=${c.rawCod}/${playbook.targets.codMin} (busy=${c.codBusyCycles}, soft~${softCod})` +
    ` cooked=${c.cookedCod}/${playbook.targets.cookMin}` +
    ` sells=${c.sells} hunts=${huntBattleCount(c)}/${playbook.targets.huntMin}` +
    ` pets=${c.petManages} cycles=${c.batchCycles} map=${c.mapPeeks}` +
    ` baitOwned=${playbook.baitOwned}` +
    ` preferred=[${playbook.preferredActions.join(',')}]`
  );
}
