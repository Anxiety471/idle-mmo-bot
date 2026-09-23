import { matchKnownItem } from '../snapshot/inventory-scrape.js';
import type { CurrentActionInfo, SkillId, SnapshotZone } from '../types.js';
import type { PublicApiSnapshotPatch } from './public-api-types.js';

export interface MappedLocations {
  zones: SnapshotZone[];
  location?: string;
  weather?: string;
}

export interface MappedIdentity {
  hashedId?: string;
  onlineStatus?: string;
  names: string[];
  currentStatus?: unknown;
}

export interface CharacterRef {
  hashedId: string;
  name?: string;
}

const SKILL_IDS = new Set<SkillId>([
  'woodcutting',
  'mining',
  'fishing',
  'alchemy',
  'smelting',
  'cooking',
  'forge',
  'construction',
]);

const ACTION_TYPE_TO_SKILL: Record<string, SkillId> = {
  woodcutting: 'woodcutting',
  mining: 'mining',
  fishing: 'fishing',
  alchemy: 'alchemy',
  smelting: 'smelting',
  cooking: 'cooking',
  forge: 'forge',
  construction: 'construction',
};

const EQUIPPED_PET_FIELDS = ['id', 'name', 'custom_name', 'quality', 'evolution'] as const;

const PET_FIELDS = [
  'id',
  'name',
  'custom_name',
  'pet_id',
  'level',
  'experience',
  'total_experience',
  'quality',
  'stats',
  'health',
  'happiness',
  'equipped',
] as const;

const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function findLocationArray(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  const record = asRecord(body);
  if (!record) return undefined;
  for (const key of ['locations', 'data']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (nested && Array.isArray(nested.locations)) return nested.locations;
  }
  return undefined;
}

function readWeather(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  if (record && typeof record.name === 'string' && record.name.trim()) return record.name.trim();
  return undefined;
}

/**
 * Best-effort map for `GET /v1/world/locations/list`.
 * The in-game schema is not published. Unknown shapes do not overwrite the DOM location.
 */
export function mapLocationsPayload(body: unknown): MappedLocations {
  const rows = findLocationArray(body) ?? [];
  const zones: SnapshotZone[] = [];
  let location: string | undefined;
  let weather: string | undefined;
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const name =
      typeof record.name === 'string'
        ? record.name.trim()
        : typeof record.location === 'string'
          ? record.location.trim()
          : '';
    if (!name) continue;
    const current = record.current === true;
    zones.push({ name, current });
    if (current && !location) location = name;
    if (current && !weather) weather = readWeather(record.weather);
  }
  return { zones, location, weather };
}

/**
 * Documented identity keys only: `hashed_id`, `online_status`.
 * A `name` on the same object as `hashed_id` is kept so multi-character accounts
 * can be checked against `CHARACTER_NAME`. `last_activity` is ignored.
 */
export function mapIdentityPayload(body: unknown): MappedIdentity {
  const names: string[] = [];
  let hashedId: string | undefined;
  let onlineStatus: string | undefined;
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number) => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (seen.has(node) || seen.size > 200) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.hashed_id === 'string' && record.hashed_id.trim()) {
      hashedId ??= record.hashed_id.trim();
      if (typeof record.name === 'string' && record.name.trim()) names.push(record.name.trim());
    }
    if (typeof record.online_status === 'string' && record.online_status.trim()) {
      onlineStatus ??= record.online_status.trim();
    }
    for (const value of Object.values(record)) walk(value, depth + 1);
  };

  walk(body, 0);
  return { hashedId, onlineStatus, names: [...new Set(names)] };
}

function quantityOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function itemLabel(record: Record<string, unknown>): string | undefined {
  if (typeof record.name !== 'string') return undefined;
  const name = record.name.trim();
  if (!name || name.length > 80) return undefined;
  return matchKnownItem(name) ?? name;
}

/**
 * Item-list helper kept for tests. The Public API client does not call this:
 * the official settings page has no character inventory route.
 * Returns undefined when the payload is not an item list, so a guild hall body
 * cannot be applied by accident.
 */
export function mapInventoryPayload(body: unknown): Record<string, number> | undefined {
  const rows = itemRows(body);
  if (!rows) return undefined;
  const inventory: Record<string, number> = {};
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const qty = quantityOf(record.quantity);
    const label = itemLabel(record);
    if (qty === undefined || !label) continue;
    inventory[label] = qty;
  }
  if (Object.keys(inventory).length === 0 && rows.length > 0) return undefined;
  return inventory;
}

function itemRows(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  const record = asRecord(body);
  if (!record) return undefined;
  for (const key of ['inventory', 'items', 'data']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

/**
 * Character pets example fields only. Unknown keys (including hunger) are dropped.
 * Happiness is included because the in-game example lists it.
 */
export function mapPetsPayload(body: unknown): Record<string, unknown>[] | undefined {
  const root = asRecord(body);
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(root?.pets)
      ? (root?.pets as unknown[])
      : Array.isArray(root?.data)
        ? (root?.data as unknown[])
        : undefined;
  if (!rows) return undefined;
  const pets: Record<string, unknown>[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const pet = pickFields(record, PET_FIELDS);
    if (pet) pets.push(pet);
  }
  return pets.length > 0 ? pets : undefined;
}

export function applyMappedIdentity(
  patch: PublicApiSnapshotPatch,
  identity: MappedIdentity,
): void {
  if (
    !identity.hashedId &&
    !identity.onlineStatus &&
    identity.names.length === 0 &&
    identity.currentStatus === undefined
  ) {
    return;
  }
  patch.identity = {
    hashedId: identity.hashedId ?? patch.identity?.hashedId,
    onlineStatus: identity.onlineStatus ?? patch.identity?.onlineStatus,
    names: identity.names.length > 0 ? identity.names : patch.identity?.names,
    currentStatus:
      identity.currentStatus !== undefined ? identity.currentStatus : patch.identity?.currentStatus,
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function skillIdOf(raw: string): SkillId | undefined {
  const id = raw.trim().toLowerCase().replace(/[\s_-]+/g, '') as SkillId;
  return SKILL_IDS.has(id) ? id : undefined;
}

function jsonSafe(value: unknown, maxLength = 2000): unknown | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object') return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length > maxLength) return undefined;
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

function pickFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in record)) continue;
    const value = jsonSafe(record[field]);
    if (value !== undefined) picked[field] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function characterRecord(body: unknown): Record<string, unknown> | undefined {
  const root = asRecord(body);
  if (!root) return undefined;
  const direct = asRecord(root.character);
  if (direct) return direct;
  const data = asRecord(root.data);
  const nested = data ? asRecord(data.character) : undefined;
  if (nested) return nested;
  if (
    'gold' in root ||
    'total_level' in root ||
    'hashed_id' in root ||
    'skills' in root ||
    'location' in root
  ) {
    return root;
  }
  return undefined;
}

function locationName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  if (record && typeof record.name === 'string' && record.name.trim()) return record.name.trim();
  return undefined;
}

function mapSkillLevels(value: unknown): Partial<Record<SkillId, number>> | undefined {
  const levels: Partial<Record<SkillId, number>> = {};
  const absorb = (key: string, levelValue: unknown) => {
    const id = skillIdOf(key);
    const level = finiteNonNegative(levelValue);
    if (!id || level === undefined) return;
    levels[id] = Math.floor(level);
  };
  if (Array.isArray(value)) {
    for (const row of value) {
      const record = asRecord(row);
      if (!record) continue;
      const key =
        typeof record.name === 'string'
          ? record.name
          : typeof record.skill === 'string'
            ? record.skill
            : '';
      if (key) absorb(key, record.level);
    }
  } else {
    const record = asRecord(value);
    if (!record) return undefined;
    for (const [key, entry] of Object.entries(record)) {
      const entryRecord = asRecord(entry);
      if (entryRecord && 'level' in entryRecord) absorb(key, entryRecord.level);
      else absorb(key, entry);
    }
  }
  return Object.keys(levels).length > 0 ? levels : undefined;
}

/**
 * Character view (`GET /v1/character/{hashed_character_id}/information`).
 * Only documented example fields are copied. Inventory stacks are ignored.
 */
export function mapCharacterInformation(body: unknown): Partial<PublicApiSnapshotPatch> {
  const character = characterRecord(body);
  if (!character) return {};
  const patch: Partial<PublicApiSnapshotPatch> = {};
  const gold = finiteNonNegative(character.gold);
  if (gold !== undefined) patch.gold = Math.floor(gold);
  const tokens = finiteNonNegative(character.tokens);
  if (tokens !== undefined) patch.tokens = Math.floor(tokens);
  const totalLevel = finiteNonNegative(character.total_level);
  if (totalLevel !== undefined) patch.totalLevel = Math.floor(totalLevel);
  const skillLevels = mapSkillLevels(character.skills);
  if (skillLevels) patch.skillLevels = skillLevels;
  const location = locationName(character.location);
  if (location) patch.location = location;
  const equipped = asRecord(character.equipped_pet);
  if (equipped) {
    const pet = pickFields(equipped, EQUIPPED_PET_FIELDS);
    if (pet) patch.equippedPet = pet;
  }
  const names =
    typeof character.name === 'string' && character.name.trim() ? [character.name.trim()] : [];
  const hashedId =
    typeof character.hashed_id === 'string' && PATH_SEGMENT.test(character.hashed_id.trim())
      ? character.hashed_id.trim()
      : undefined;
  const currentStatus = jsonSafe(character.current_status);
  if (hashedId || names.length > 0 || currentStatus !== undefined) {
    patch.identity = {
      hashedId,
      names,
      ...(currentStatus !== undefined ? { currentStatus } : {}),
    };
  }
  return patch;
}

function actionRecord(body: unknown): Record<string, unknown> | undefined | null {
  if (body === null) return null;
  const root = asRecord(body);
  if (!root) return undefined;
  if (
    'type' in root ||
    'item' in root ||
    'title' in root ||
    'started_at' in root ||
    'expires_at' in root
  ) {
    return root;
  }
  for (const key of ['data', 'action', 'current_action']) {
    if (root[key] === null) return null;
    const nested = asRecord(root[key]);
    if (!nested) continue;
    if (
      'type' in nested ||
      'item' in nested ||
      'title' in nested ||
      'started_at' in nested ||
      'expires_at' in nested ||
      Object.keys(nested).length === 0
    ) {
      return nested;
    }
  }
  if (Object.keys(root).length === 0) return root;
  return undefined;
}

/**
 * Current action example fields only: type, item, title, started_at, expires_at.
 * `image_url` is ignored. No battle, health, or combat-phase fields are inferred.
 * Returns undefined when the body is not an action payload, so the scrape is kept.
 */
export function mapCurrentActionPayload(body: unknown): CurrentActionInfo | undefined {
  const record = actionRecord(body);
  if (record === undefined) return undefined;
  if (record === null || Object.keys(record).length === 0) return { busy: false };
  const type = typeof record.type === 'string' ? record.type.trim() : '';
  if (!type) {
    if ('type' in record || 'item' in record || 'title' in record) return { busy: false };
    return undefined;
  }
  const skill = ACTION_TYPE_TO_SKILL[type.toLowerCase()];
  const item = typeof record.item === 'string' ? record.item.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const startedAt = typeof record.started_at === 'string' ? record.started_at : undefined;
  const expiresAt = typeof record.expires_at === 'string' ? record.expires_at : undefined;
  return {
    busy: true,
    type,
    ...(skill ? { skill } : {}),
    ...(item ? { resource: item } : {}),
    ...(title ? { label: title } : item ? { label: item } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/** Walk a payload for `{ hashed_id, name? }` pairs. Names are required to select a character. */
export function collectCharacterRefs(body: unknown): CharacterRef[] {
  const refs: CharacterRef[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (seen.has(node) || seen.size > 400) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const hashedId = typeof record.hashed_id === 'string' ? record.hashed_id.trim() : '';
    if (hashedId && PATH_SEGMENT.test(hashedId)) {
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      refs.push({ hashedId, ...(name ? { name } : {}) });
    }
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(body, 0);
  const byId = new Map<string, CharacterRef>();
  for (const ref of refs) {
    const existing = byId.get(ref.hashedId);
    if (!existing || (!existing.name && ref.name)) byId.set(ref.hashedId, ref);
  }
  return [...byId.values()];
}

/**
 * Pick the character whose name matches `CHARACTER_NAME`.
 * With no name configured, use the only named character. Never guess among several.
 */
export function selectCharacterHashedId(
  refs: readonly CharacterRef[],
  characterName: string | undefined,
): string | undefined {
  const named = refs.filter((ref) => ref.name);
  if (characterName) {
    const wanted = characterName.toLowerCase();
    return named.find((ref) => ref.name?.toLowerCase() === wanted)?.hashedId;
  }
  if (named.length === 1) return named[0]?.hashedId;
  return undefined;
}

export function applyCharacterInformation(
  patch: PublicApiSnapshotPatch,
  mapped: Partial<PublicApiSnapshotPatch>,
): void {
  if (mapped.gold !== undefined) patch.gold = mapped.gold;
  if (mapped.tokens !== undefined) patch.tokens = mapped.tokens;
  if (mapped.totalLevel !== undefined) patch.totalLevel = mapped.totalLevel;
  if (mapped.skillLevels) patch.skillLevels = { ...(patch.skillLevels ?? {}), ...mapped.skillLevels };
  if (mapped.location) patch.location = mapped.location;
  if (mapped.equippedPet) patch.equippedPet = mapped.equippedPet;
  if (mapped.identity) {
    applyMappedIdentity(patch, {
      hashedId: mapped.identity.hashedId,
      names: mapped.identity.names ?? [],
      currentStatus: mapped.identity.currentStatus,
    });
  }
}
