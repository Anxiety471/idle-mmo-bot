import {
  formatPublicApiLog,
  loadIdleMmoApiConfig,
  logPublicApiStatus,
  readPublicApi,
} from '../api/idle-mmo-api.js';
import type { PublicApiRead } from '../api/public-api-types.js';
import type { GameSnapshot } from '../types.js';
import { detectHasBait } from './inventory-scrape.js';

function mentionsBait(inventory: Record<string, number>): boolean {
  return Object.keys(inventory).some((name) => /bait/i.test(name));
}

/**
 * Prefer Public API values for fields the read actually produced.
 * DOM values stay for everything the API did not return.
 * Cook-before-hunt thresholds are not modified here.
 */
export function mergePublicApiIntoSnapshot(
  snapshot: GameSnapshot,
  read: PublicApiRead,
): GameSnapshot {
  const patch = read.patch;
  const inventory = patch.inventory
    ? { ...snapshot.inventory, ...patch.inventory }
    : snapshot.inventory;

  let hasBait = snapshot.flags.hasBait;
  if (patch.inventory) {
    const fromCounts = detectHasBait(inventory, '');
    hasBait = mentionsBait(patch.inventory) ? fromCounts : snapshot.flags.hasBait || fromCounts;
  }

  const gatherBusy = patch.currentAction ? patch.currentAction.busy : snapshot.flags.gatherBusy;
  const inBattle =
    patch.combatPhase !== undefined ? patch.combatPhase === 'battle' : snapshot.flags.inBattle;

  return {
    ...snapshot,
    location: patch.location ?? snapshot.location,
    zones: patch.zones ?? snapshot.zones,
    totalLevel: patch.totalLevel ?? snapshot.totalLevel,
    combatLevel: patch.combatLevel ?? snapshot.combatLevel,
    gold: patch.gold ?? snapshot.gold,
    tokens: patch.tokens ?? snapshot.tokens,
    skillLevels: patch.skillLevels
      ? { ...snapshot.skillLevels, ...patch.skillLevels }
      : snapshot.skillLevels,
    inventory,
    acceptedQuests: patch.acceptedQuests ?? snapshot.acceptedQuests,
    pendingQuests: patch.pendingQuests ?? snapshot.pendingQuests,
    combatPhase: patch.combatPhase ?? snapshot.combatPhase,
    totalEnemiesFound: patch.totalEnemiesFound ?? snapshot.totalEnemiesFound,
    enemiesRemaining: patch.enemiesRemaining ?? snapshot.enemiesRemaining,
    currentAction: patch.currentAction ?? snapshot.currentAction,
    features: {
      ...snapshot.features,
      ...(patch.weather ? { weather: patch.weather } : {}),
    },
    extensions: {
      ...snapshot.extensions,
      publicApi: {
        fetchedAt: read.fetchedAt,
        fromCache: read.fromCache,
        endpointsUsed: read.endpointsUsed,
        errors: read.errors.map((error) => ({ id: error.id, code: error.code })),
        unavailable: read.unavailable.map((resource) => ({
          id: resource.id,
          reason: resource.reason,
          snapshotFields: resource.snapshotFields,
        })),
        ...(patch.pets ? { pets: patch.pets } : {}),
        ...(patch.equippedPet ? { equippedPet: patch.equippedPet } : {}),
        ...(patch.identity ? { identity: patch.identity } : {}),
        ...read.meta,
      },
    },
    flags: {
      ...snapshot.flags,
      hasBait,
      gatherBusy,
      inBattle,
      bankNearby: patch.bankNearby ?? snapshot.flags.bankNearby,
    },
  };
}

/** When a key is set, refresh documented `/v1` data and overlay it. Failures keep the scrape. */
export async function applyPublicApiToSnapshot(
  snapshot: GameSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GameSnapshot> {
  const loaded = loadIdleMmoApiConfig(env);
  if (!loaded.enabled) {
    if (loaded.reason === 'missing-base') logPublicApiStatus(loaded.message);
    return snapshot;
  }

  try {
    const result = await readPublicApi(env);
    if (!result.enabled) return snapshot;
    const line = formatPublicApiLog(result.read, loaded.config.characterName);
    logPublicApiStatus(line, Boolean(result.read.patch.inventory));
    return mergePublicApiIntoSnapshot(snapshot, result.read);
  } catch {
    logPublicApiStatus('[snapshot] Public API failed (error); Playwright scrape kept');
    return snapshot;
  }
}
