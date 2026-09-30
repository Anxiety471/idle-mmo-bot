import type { GameSnapshot } from '../types.js';

export interface SnapshotHealthState {
  lastInventory: Record<string, number>;
  lastItemTypeCount: number;
  lastCombatLevel?: number;
  rawCodBagReads: number[];
  /** Consecutive inventory reads held back as collapsed (bounded by MAX_CONSECUTIVE_DEGRADED). */
  inventoryDegradedStreak?: number;
  /** Consecutive profile reads with no combat level (bounded by MAX_CONSECUTIVE_DEGRADED). */
  combatMissStreak?: number;
}

/**
 * A collapsed/missing read may be held back at most this many cycles in a row.
 * The next read is then trusted, so a legitimately changed page (sold stock,
 * missing combat line) can never freeze the playbook in degraded mode.
 */
export const MAX_CONSECUTIVE_DEGRADED = 2;

export function emptySnapshotHealthState(): SnapshotHealthState {
  return {
    lastInventory: {},
    lastItemTypeCount: 0,
    rawCodBagReads: [],
  };
}

function inventoryItemTypeCount(inventory: Record<string, number>): number {
  return Object.values(inventory).filter((qty) => qty > 0).length;
}

function trackedStackTotal(inventory: Record<string, number>): number {
  const keys = ['Cooked Cod', 'Raw Cod', 'Coal Ore', 'Cheap Bait', 'Oak Log', 'Yew Log'];
  return keys.reduce((sum, key) => sum + (inventory[key] ?? 0), 0);
}

export function inventoryReadLooksCollapsed(
  previous: Record<string, number>,
  fresh: Record<string, number>,
): boolean {
  const prevTypes = inventoryItemTypeCount(previous);
  const freshTypes = inventoryItemTypeCount(fresh);
  if (prevTypes >= 6 && freshTypes <= 2) return true;
  const prevTracked = trackedStackTotal(previous);
  const freshTracked = trackedStackTotal(fresh);
  if (prevTracked >= 50 && freshTracked === 0 && freshTypes <= 2) return true;
  return false;
}

export interface InventorySanityResult {
  inventory: Record<string, number>;
  degraded: boolean;
  state: SnapshotHealthState;
}

/** Keep prior inventory when a scrape collapses suddenly (slow/partial DOM). */
export function applyInventorySanity(
  state: SnapshotHealthState,
  fresh: Record<string, number>,
): InventorySanityResult {
  const streak = state.inventoryDegradedStreak ?? 0;
  const collapsed =
    inventoryItemTypeCount(state.lastInventory) > 0 &&
    inventoryReadLooksCollapsed(state.lastInventory, fresh);
  if (collapsed && streak < MAX_CONSECUTIVE_DEGRADED) {
    return {
      inventory: { ...state.lastInventory },
      degraded: true,
      state: {
        ...state,
        rawCodBagReads: [...state.rawCodBagReads],
        inventoryDegradedStreak: streak + 1,
      },
    };
  }

  const nextState: SnapshotHealthState = {
    ...state,
    lastInventory: { ...fresh },
    lastItemTypeCount: inventoryItemTypeCount(fresh),
    lastCombatLevel: state.lastCombatLevel,
    rawCodBagReads: [...state.rawCodBagReads],
    inventoryDegradedStreak: 0,
  };
  return { inventory: fresh, degraded: false, state: nextState };
}

export function recordRawCodBagRead(state: SnapshotHealthState, bagRawCod: number): SnapshotHealthState {
  const reads = [...state.rawCodBagReads, bagRawCod].slice(-2);
  return { ...state, rawCodBagReads: reads };
}

/** Two consecutive zero reads before trusting Raw Cod = 0. */
export function rawCodZeroConfirmed(state: SnapshotHealthState): boolean {
  const reads = state.rawCodBagReads;
  return reads.length >= 2 && reads.every((v) => v === 0);
}

export interface CombatLevelSanityResult {
  combatLevel?: number;
  degraded: boolean;
  state: SnapshotHealthState;
}

export function applyCombatLevelSanity(
  state: SnapshotHealthState,
  parsed?: number,
): CombatLevelSanityResult {
  if (parsed !== undefined && Number.isFinite(parsed)) {
    return {
      combatLevel: parsed,
      degraded: false,
      state: { ...state, lastCombatLevel: parsed, combatMissStreak: 0 },
    };
  }
  const misses = (state.combatMissStreak ?? 0) + 1;
  // Bounded: after MAX_CONSECUTIVE_DEGRADED misses the level is treated as
  // legitimately absent (keep last known value) and no longer degrades the cycle.
  const degraded = misses <= MAX_CONSECUTIVE_DEGRADED;
  const nextState = { ...state, combatMissStreak: misses };
  return { combatLevel: state.lastCombatLevel, degraded, state: nextState };
}

export function baitCountLooksLikePresenceFallback(
  inventory: Record<string, number>,
  inventoryDegraded: boolean,
): boolean {
  if (!inventoryDegraded) return false;
  const bait = (inventory['Cheap Bait'] ?? 0) + (inventory['Bait'] ?? 0);
  return bait === 1;
}

let moduleHealthState = emptySnapshotHealthState();

export function getSnapshotHealthStateForTest(): SnapshotHealthState {
  return moduleHealthState;
}

export function resetSnapshotHealthStateForTest(): void {
  moduleHealthState = emptySnapshotHealthState();
}

export function noteSnapshotHealthFromSnapshot(snapshot: GameSnapshot): void {
  moduleHealthState = {
    ...moduleHealthState,
    lastInventory: { ...snapshot.inventory },
    lastItemTypeCount: inventoryItemTypeCount(snapshot.inventory),
    lastCombatLevel: snapshot.combatLevel ?? moduleHealthState.lastCombatLevel,
    rawCodBagReads: moduleHealthState.rawCodBagReads,
  };
}

export function getSnapshotHealthState(): SnapshotHealthState {
  return moduleHealthState;
}

export function setSnapshotHealthState(state: SnapshotHealthState): void {
  moduleHealthState = state;
}
