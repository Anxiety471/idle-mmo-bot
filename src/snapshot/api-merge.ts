import {
  canonicalInventoryKey,
  getIdleMmoApiClient,
  IdleMmoApiError,
  type PublicApiRead,
} from '../api/idle-mmo-api.js';
import { detectHasBait } from './inventory-scrape.js';
import type { GameSnapshot } from '../types.js';

export interface PublicApiSnapshotSource {
  readSnapshot(expectedCharacterName?: string): Promise<PublicApiRead | null>;
}

/**
 * API quantities replace scrape quantities for the same canonical item.
 * Scrape-only keys stay. A null API inventory leaves the scrape map untouched.
 */
export function mergeInventoryQuantities(
  scrape: Record<string, number> | null | undefined,
  api: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...(scrape ?? {}) };
  const apiCanon = new Map<string, number>();
  for (const [rawName, qty] of Object.entries(api)) {
    if (!Number.isFinite(qty) || qty < 0) continue;
    const name = canonicalInventoryKey(rawName);
    const previous = apiCanon.get(name);
    apiCanon.set(name, previous === undefined ? qty : Math.max(previous, qty));
  }

  for (const [name, qty] of apiCanon) {
    for (const key of Object.keys(out)) {
      if (canonicalInventoryKey(key) === name) delete out[key];
    }
    out[name] = qty;
  }
  return out;
}

export function mergeSnapshotWithApi(snapshot: GameSnapshot, api: PublicApiRead): GameSnapshot {
  if (api.skipped) return snapshot;

  const inventory =
    api.inventory === null
      ? snapshot.inventory
      : mergeInventoryQuantities(snapshot.inventory, api.inventory);

  const next: GameSnapshot = {
    ...snapshot,
    inventory,
    skillLevels: { ...snapshot.skillLevels, ...api.skillLevels },
    flags: { ...snapshot.flags },
  };

  if (api.gold !== undefined) next.gold = api.gold;
  if (api.tokens !== undefined) next.tokens = api.tokens;
  if (api.totalLevel !== undefined) next.totalLevel = api.totalLevel;
  if (api.combatLevel !== undefined) next.combatLevel = api.combatLevel;
  if (api.location) next.location = api.location;
  if (api.currentAction) {
    next.currentAction = api.currentAction;
    if (api.currentAction.busy && api.currentAction.skill) {
      next.flags.gatherBusy = true;
    }
  }
  if (api.inventory !== null) {
    next.flags.hasBait = detectHasBait(next.inventory, '');
  }
  return next;
}

let loggedApiFailure = false;

/** Test hook — allow the one-line API failure warning to fire again. */
export function resetApiMergeStateForTests(): void {
  loggedApiFailure = false;
}

/**
 * When `IDLE_MMO_API_KEY` is set, overlay documented public-API fields.
 * Failures keep the Playwright scrape.
 */
export async function applyPublicApiToSnapshot(
  snapshot: GameSnapshot,
  options?: { characterName?: string; client?: PublicApiSnapshotSource | null },
): Promise<GameSnapshot> {
  let client: PublicApiSnapshotSource | null;
  try {
    client = options && 'client' in options ? (options.client ?? null) : getIdleMmoApiClient();
  } catch (error) {
    const code = error instanceof IdleMmoApiError ? error.code : 'error';
    if (!loggedApiFailure) {
      loggedApiFailure = true;
      console.warn(`[snapshot] IdleMMO public API failed (${code}) — DOM scrape kept`);
    }
    return snapshot;
  }
  if (!client) return snapshot;

  try {
    const api = await client.readSnapshot(options?.characterName);
    if (!api) return snapshot;
    if (api.skipped === 'name_mismatch') {
      console.warn(
        `[snapshot] API character "${api.characterName ?? 'unknown'}" does not match CHARACTER_NAME — DOM scrape kept`,
      );
      return snapshot;
    }
    const merged = mergeSnapshotWithApi(snapshot, api);
    if (api.inventory !== null) {
      const stacks = Object.keys(api.inventory).length;
      console.log(`[snapshot] API inventory used (${stacks} stacks)`);
    }
    loggedApiFailure = false;
    return merged;
  } catch (error) {
    const code = error instanceof IdleMmoApiError ? error.code : 'error';
    if (!loggedApiFailure) {
      loggedApiFailure = true;
      console.warn(`[snapshot] IdleMMO public API failed (${code}) — DOM scrape kept`);
    }
    return snapshot;
  }
}
