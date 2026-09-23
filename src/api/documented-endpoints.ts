/**
 * IdleMMO Public API allowlist.
 *
 * Source of truth: Account settings → Public API
 * https://web.idle-mmo.com/settings/api
 * Extracted 2026-09-23. Every path below is one of the 24 routes on that page.
 *
 * Autopilot refresh calls only `resolve`, `priority`, and (when the local
 * 20/min budget still has a slot) `optional` routes. `off` routes stay
 * callable for an explicit future read but are not requested every cycle.
 *
 * There is no character inventory route on the official page. Do not add one.
 */

export type PublicApiRole =
  | 'auth'
  | 'locations'
  | 'guild'
  | 'character'
  | 'action'
  | 'pets'
  | 'items'
  | 'combat'
  | 'shrine';

/** Which autopilot refresh wave may call this route. */
export type RefreshTier = 'resolve' | 'priority' | 'optional' | 'off';

export interface DocumentedEndpoint {
  id: string;
  method: 'GET';
  path: string;
  scopes: string[];
  role: PublicApiRole;
  /** `off` = allowlisted, not polled by autopilot refresh. */
  refresh: RefreshTier;
  summary: string;
  snapshotFields: string[];
}

export const DOCUMENTED_ENDPOINTS: readonly DocumentedEndpoint[] = [
  {
    id: 'auth-check',
    method: 'GET',
    path: '/v1/auth/check',
    scopes: ['v1.auth.check'],
    role: 'auth',
    refresh: 'resolve',
    summary: 'Authentication check. Used to discover hashed_character_id when IDLE_MMO_CHARACTER_HASHED_ID is unset.',
    snapshotFields: ['extensions.publicApi.identity', 'extensions.publicApi.authOk'],
  },
  {
    id: 'world-locations',
    method: 'GET',
    path: '/v1/world/locations/list',
    scopes: ['v1.world.locations.list'],
    role: 'locations',
    refresh: 'off',
    summary: 'World locations list. Allowlisted. Not called on the autopilot refresh wave.',
    snapshotFields: ['zones', 'location', 'features.weather'],
  },
  {
    id: 'world-bosses',
    method: 'GET',
    path: '/v1/combat/world_bosses/list',
    scopes: ['v1.combat.world_bosses.list'],
    role: 'combat',
    refresh: 'off',
    summary: 'World bosses list. Allowlisted catalog. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'dungeons-list',
    method: 'GET',
    path: '/v1/combat/dungeons/list',
    scopes: ['v1.combat.dungeons.list'],
    role: 'combat',
    refresh: 'off',
    summary: 'Dungeons list. Allowlisted catalog. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'enemies-list',
    method: 'GET',
    path: '/v1/combat/enemies/list',
    scopes: ['v1.combat.enemies.list'],
    role: 'combat',
    refresh: 'off',
    summary: 'Enemies list. Allowlisted catalog. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'item-search',
    method: 'GET',
    path: '/v1/item/search',
    scopes: ['v1.item.search'],
    role: 'items',
    refresh: 'off',
    summary: 'Global item catalog search. Not per-character inventory. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'item-inspection',
    method: 'GET',
    path: '/v1/item/{hashed_item_id}/inspect',
    scopes: ['v1.item.inspect'],
    role: 'items',
    refresh: 'off',
    summary: 'Global item inspect. Not a character bag. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'item-market-history',
    method: 'GET',
    path: '/v1/item/{hashed_item_id}/market-history',
    scopes: ['v1.item.market_history'],
    role: 'items',
    refresh: 'off',
    summary: 'Item market history. Not a character bag. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'character-information',
    method: 'GET',
    path: '/v1/character/{hashed_character_id}/information',
    scopes: ['v1.character.view'],
    role: 'character',
    refresh: 'priority',
    summary:
      'Character view. Maps gold, tokens, total_level, skills, location, equipped_pet, current_status, name, and hashed_id from the documented example.',
    snapshotFields: [
      'gold',
      'tokens',
      'totalLevel',
      'skillLevels',
      'location',
      'extensions.publicApi.equippedPet',
      'extensions.publicApi.identity',
    ],
  },
  {
    id: 'character-metrics',
    method: 'GET',
    path: '/v1/character/{hashed_character_id}/metrics',
    scopes: ['v1.character.metrics'],
    role: 'character',
    refresh: 'off',
    summary: 'Lifetime metrics (for example battle.food_used). Not bag stacks. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'character-effects',
    method: 'GET',
    path: '/v1/character/{hashed_character_id}/effects',
    scopes: ['v1.character.effects'],
    role: 'character',
    refresh: 'off',
    summary: 'Character effects. Allowlisted. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'character-characters',
    method: 'GET',
    path: '/v1/character/{hashed_character_id}/characters',
    scopes: ['v1.character.characters'],
    role: 'character',
    refresh: 'resolve',
    summary:
      'Alt characters. Called only when auth/check did not already match CHARACTER_NAME to a hashed id.',
    snapshotFields: ['extensions.publicApi.identity'],
  },
  {
    id: 'character-museum',
    method: 'GET',
    path: '/v1/character/{hashed_character_id}/museum',
    scopes: ['v1.character.museum'],
    role: 'character',
    refresh: 'off',
    summary: 'Museum collectibles. Not character bag inventory. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'current-action',
    method: 'GET',
    path: '/v1/character/{hashed_character_id}/current-action',
    scopes: ['v1.character.current_action'],
    role: 'action',
    refresh: 'priority',
    summary:
      'Current action. Maps type, item, title, started_at, and expires_at. An active type (for example MINING) sets gatherBusy. Battle fields are not invented.',
    snapshotFields: ['currentAction', 'flags.gatherBusy'],
  },
  {
    id: 'character-pets',
    method: 'GET',
    path: '/v1/character/{hashed_character_id}/pets',
    scopes: ['v1.character.pets'],
    role: 'pets',
    refresh: 'optional',
    summary: 'Character pets. Same refresh wave as information and current-action when the local rate budget still has a slot.',
    snapshotFields: ['extensions.publicApi.pets'],
  },
  {
    id: 'companion-exchange',
    method: 'GET',
    path: '/v1/pets/companion-exchange/listings',
    scopes: ['v1.pets.companion_exchange.listings'],
    role: 'pets',
    refresh: 'off',
    summary: 'Companion exchange listings. Allowlisted. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'guild-information',
    method: 'GET',
    path: '/v1/guild/{id}/information',
    scopes: ['v1.guild.information'],
    role: 'guild',
    refresh: 'off',
    summary: 'Guild information. Allowlisted. Not called every refresh cycle.',
    snapshotFields: ['extensions.publicApi.guild'],
  },
  {
    id: 'guild-members',
    method: 'GET',
    path: '/v1/guild/{id}/members',
    scopes: ['v1.guild.members'],
    role: 'guild',
    refresh: 'off',
    summary: 'Guild members. Allowlisted. Not called every refresh cycle.',
    snapshotFields: ['extensions.publicApi.guild.members'],
  },
  {
    id: 'guild-activity',
    method: 'GET',
    path: '/v1/guild/{id}/activity',
    scopes: ['v1.guild.activity'],
    role: 'guild',
    refresh: 'off',
    summary: 'Guild activity. Allowlisted. Not called every refresh cycle.',
    snapshotFields: ['extensions.publicApi.guild.activity'],
  },
  {
    id: 'guild-energizing-pool',
    method: 'GET',
    path: '/v1/guild/{id}/energizing-pool/information',
    scopes: ['v1.guild.energizing_pool.information'],
    role: 'guild',
    refresh: 'off',
    summary: 'Guild energizing pool. Allowlisted. Not called every refresh cycle.',
    snapshotFields: ['extensions.publicApi.guild.energizingPool'],
  },
  {
    id: 'guild-hall',
    method: 'GET',
    path: '/v1/guild/{id}/hall',
    scopes: ['v1.guild.hall'],
    role: 'guild',
    refresh: 'off',
    summary: 'Guild hall. Not character inventory and not called every refresh cycle.',
    snapshotFields: ['extensions.publicApi.guild.hall'],
  },
  {
    id: 'guild-conquest',
    method: 'GET',
    path: '/v1/guild/conquest/view',
    scopes: ['v1.guild.conquest.view'],
    role: 'guild',
    refresh: 'off',
    summary: 'Guild conquest view. Allowlisted. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'guild-conquest-zone',
    method: 'GET',
    path: '/v1/guild/conquest/zone/{zone_id}/inspect',
    scopes: ['v1.guild.conquest.zone.inspect'],
    role: 'guild',
    refresh: 'off',
    summary: 'Guild conquest zone inspect. Allowlisted. Not called every refresh cycle.',
    snapshotFields: [],
  },
  {
    id: 'shrine-progress',
    method: 'GET',
    path: '/v1/shrine/progress',
    scopes: ['v1.shrine.progress'],
    role: 'shrine',
    refresh: 'off',
    summary: 'Shrine progress. Allowlisted. Not called every refresh cycle.',
    snapshotFields: [],
  },
];

export const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

const PLACEHOLDERS: Record<string, keyof PathIds> = {
  '{id}': 'guildId',
  '{hashed_character_id}': 'characterId',
  '{hashed_item_id}': 'itemId',
  '{zone_id}': 'zoneId',
};

export interface PathIds {
  guildId?: string;
  characterId?: string;
  itemId?: string;
  zoneId?: string;
}

export function documentedEndpoint(id: string): DocumentedEndpoint {
  const endpoint = DOCUMENTED_ENDPOINTS.find((item) => item.id === id);
  if (!endpoint) throw new Error(`Unknown documented endpoint "${id}"`);
  return endpoint;
}

/** Worst-case requests on one autopilot refresh, including optional pets. */
export function plannedRefreshRequests(hasCharacterId: boolean): number {
  const priority = DOCUMENTED_ENDPOINTS.filter((endpoint) => endpoint.refresh === 'priority').length;
  const optional = DOCUMENTED_ENDPOINTS.filter((endpoint) => endpoint.refresh === 'optional').length;
  if (hasCharacterId) return priority + optional;
  const resolve = DOCUMENTED_ENDPOINTS.filter((endpoint) => endpoint.refresh === 'resolve').length;
  return resolve + priority + optional;
}

export function resolveDocumentedPath(endpoint: DocumentedEndpoint, ids: PathIds = {}): string {
  let path = endpoint.path;
  for (const [token, key] of Object.entries(PLACEHOLDERS)) {
    if (!path.includes(token)) continue;
    const value = ids[key];
    if (!value || !PATH_SEGMENT.test(value)) {
      throw new Error(`Public API resource "${endpoint.id}" is missing a valid ${token} segment`);
    }
    path = path.split(token).join(value);
  }
  if (path.includes('{') || path.includes('}')) {
    throw new Error(`Public API resource "${endpoint.id}" has an unresolved path token`);
  }
  assertDocumentedPath(path);
  return path;
}

const SEGMENT_SOURCE = '[A-Za-z0-9_-]{1,128}';

function templateRegex(template: string): RegExp {
  const parts = template.split(/(\{[a-z_]+\})/g).map((part) => {
    if (!part.startsWith('{')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!Object.prototype.hasOwnProperty.call(PLACEHOLDERS, part)) {
      throw new Error(`Undocumented path token ${part}`);
    }
    return SEGMENT_SOURCE;
  });
  return new RegExp(`^${parts.join('')}$`);
}

/** Reject anything that is not an exact resolved path from the official 24-route catalog. */
export function assertDocumentedPath(path: string): void {
  if (
    !path.startsWith('/v1/') ||
    path.includes('..') ||
    path.includes('//') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('{') ||
    path.toLowerCase().includes('inventory')
  ) {
    throw new Error('Refusing non-public Public API path');
  }
  for (const endpoint of DOCUMENTED_ENDPOINTS) {
    if (templateRegex(endpoint.path).test(path)) return;
  }
  throw new Error('Refusing Public API path that is not in the official catalog');
}
