import { matchKnownItem } from '../snapshot/inventory-scrape.js';
import type { SnapshotZone } from '../types.js';
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
}

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
 * Inventory role only. Reads stacks that include the documented `quantity` field.
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

/** Pets role: keep documented `total_experience` only. Do not read removed hunger/happiness. */
export function mapPetsPayload(body: unknown): Record<string, unknown>[] | undefined {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(asRecord(body)?.pets)
      ? (asRecord(body)?.pets as unknown[])
      : Array.isArray(asRecord(body)?.data)
        ? (asRecord(body)?.data as unknown[])
        : undefined;
  if (!rows) return undefined;
  const pets: Record<string, unknown>[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record || !('total_experience' in record)) continue;
    const experience = quantityOf(record.total_experience);
    if (experience === undefined) continue;
    const pet: Record<string, unknown> = { total_experience: experience };
    if (typeof record.hashed_id === 'string') pet.hashed_id = record.hashed_id;
    pets.push(pet);
  }
  return pets.length > 0 ? pets : undefined;
}

export function applyMappedIdentity(
  patch: PublicApiSnapshotPatch,
  identity: MappedIdentity,
): void {
  if (!identity.hashedId && !identity.onlineStatus && identity.names.length === 0) return;
  patch.identity = {
    hashedId: identity.hashedId ?? patch.identity?.hashedId,
    onlineStatus: identity.onlineStatus ?? patch.identity?.onlineStatus,
    names: identity.names.length > 0 ? identity.names : patch.identity?.names,
  };
}
