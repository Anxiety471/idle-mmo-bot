/**
 * IdleMMO Public API routes that appear in official public docs.
 *
 * Sources (do not add a path that is not in one of these):
 * - https://wiki.idle-mmo.com/more/api — `GET /v1/auth/check`, Bearer auth, 20/min
 * - https://web.idle-mmo.com/patch-notes?page=4 — guild hall, energizing pool, world locations
 * - https://web.idle-mmo.com/patch-notes?page=3 — guild activity path + `v1.character.characters`
 *
 * Resources named in patch notes without a `/v1/` path stay `path: null` and are never requested.
 */

export type PublicApiRole =
  | 'auth'
  | 'locations'
  | 'guild'
  | 'character'
  | 'inventory'
  | 'action'
  | 'pets'
  | 'items'
  | 'world-bosses';

export interface DocumentedEndpoint {
  id: string;
  method: 'GET';
  /** Null when official notes name the resource but do not publish a path. */
  path: string | null;
  /** Path template contains `{id}` filled from `IDLE_MMO_GUILD_ID`. */
  guildId?: boolean;
  scopes: string[];
  role: PublicApiRole;
  summary: string;
  snapshotFields: string[];
}

export const DOCUMENTED_ENDPOINTS: readonly DocumentedEndpoint[] = [
  {
    id: 'auth-check',
    method: 'GET',
    path: '/v1/auth/check',
    scopes: [],
    role: 'auth',
    summary: 'Bearer token check. Wiki example. Identity fields are read only when the JSON includes documented keys.',
    snapshotFields: ['extensions.publicApi.identity', 'extensions.publicApi.authOk'],
  },
  {
    id: 'world-locations',
    method: 'GET',
    path: '/v1/world/locations/list',
    scopes: [],
    role: 'locations',
    summary: 'Location list with weather forecast. Dates are UTC (patch notes).',
    snapshotFields: ['zones', 'location', 'features.weather'],
  },
  {
    id: 'guild-activity',
    method: 'GET',
    path: '/v1/guild/{id}/activity',
    guildId: true,
    scopes: ['guild endpoint scope', 'v1.character.characters'],
    role: 'guild',
    summary: 'Guild activity. Requires the guild scope plus v1.character.characters.',
    snapshotFields: ['extensions.publicApi.guild.activity'],
  },
  {
    id: 'guild-energizing-pool',
    method: 'GET',
    path: '/v1/guild/{id}/energizing-pool/information',
    guildId: true,
    scopes: ['guild endpoint scope', 'v1.character.characters'],
    role: 'guild',
    summary: 'Guild energizing pool information.',
    snapshotFields: ['extensions.publicApi.guild.energizingPool'],
  },
  {
    id: 'guild-hall',
    method: 'GET',
    path: '/v1/guild/{id}/hall',
    guildId: true,
    scopes: ['guild endpoint scope', 'v1.character.characters'],
    role: 'guild',
    summary:
      'Guild hall, including stockpile quantities. Stockpile is guild storage and is not copied onto character inventory.',
    snapshotFields: ['extensions.publicApi.guild.hall'],
  },
  {
    id: 'character-information',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'character',
    summary:
      'Character information endpoint (equipped pet base name, custom name, pet id, quality, evolution; location details). Path is not in the wiki or patch notes.',
    snapshotFields: [
      'location',
      'extensions.publicApi.pets',
      'extensions.publicApi.identity',
      'totalLevel',
      'combatLevel',
      'gold',
      'tokens',
      'skillLevels',
    ],
  },
  {
    id: 'character-inspection',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'character',
    summary:
      'Character inspection. Documented fields: online_status. last_activity was deprecated and then removed — ignored if present.',
    snapshotFields: ['extensions.publicApi.identity.onlineStatus', 'extensions.publicApi.identity.hashedId'],
  },
  {
    id: 'inventory',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'inventory',
    summary:
      'Character item quantities (Cooked Cod, Raw Cod, Coal, bait, and other stacks). No inventory path is published on the wiki or in patch notes. quantity/chance casting is documented only as a cross-endpoint fix.',
    snapshotFields: ['inventory', 'flags.hasBait'],
  },
  {
    id: 'current-action',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'action',
    summary:
      'Characters current action endpoint (including world-boss lobby). Response schema is not published, so progress/busy/health are not inferred.',
    snapshotFields: ['currentAction', 'flags.gatherBusy', 'flags.inBattle', 'combatPhase'],
  },
  {
    id: 'pets',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'pets',
    summary:
      'Pets endpoint: base name separate from custom name, total_experience, evolution, stat breakdown. Happiness and hunger were removed. Private pet inventories return 403.',
    snapshotFields: ['extensions.publicApi.pets'],
  },
  {
    id: 'character-pet',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'pets',
    summary: 'Character pet endpoint (equipped pet stats). Path unpublished.',
    snapshotFields: ['extensions.publicApi.pets'],
  },
  {
    id: 'item-inspection',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'items',
    summary:
      'Item inspection: upgrade_requirements hashed item id, dungeon list for alchemy chests, effects. Not a character inventory listing.',
    snapshotFields: [],
  },
  {
    id: 'item-search',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'items',
    summary: 'Item search with an optional type filter. Path unpublished. Not used for autopilot quantities.',
    snapshotFields: [],
  },
  {
    id: 'pet-exchange',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'items',
    summary: 'Pet Exchange endpoint. Path unpublished.',
    snapshotFields: [],
  },
  {
    id: 'guild-members',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'guild',
    summary: 'Guild members list, including hashed_id. Path unpublished.',
    snapshotFields: ['extensions.publicApi.guild.members'],
  },
  {
    id: 'world-bosses',
    method: 'GET',
    path: null,
    scopes: [],
    role: 'world-bosses',
    summary:
      'Patch notes say world-boss timers must use the Public API. The path is not published. Spawn data is not scraped from undocumented routes.',
    snapshotFields: ['extensions.publicApi.worldBosses'],
  },
];

const GUILD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function callableEndpoints(guildId: string | undefined): DocumentedEndpoint[] {
  return DOCUMENTED_ENDPOINTS.filter((endpoint) => {
    if (!endpoint.path) return false;
    if (endpoint.guildId && !guildId) return false;
    return true;
  });
}

export function unpublishedEndpoints(): DocumentedEndpoint[] {
  return DOCUMENTED_ENDPOINTS.filter((endpoint) => !endpoint.path);
}

export function resolveDocumentedPath(endpoint: DocumentedEndpoint, guildId?: string): string {
  if (!endpoint.path) {
    throw new Error(`Public API resource "${endpoint.id}" has no published /v1 path`);
  }
  let path = endpoint.path;
  if (endpoint.guildId) {
    if (!guildId || !GUILD_ID_PATTERN.test(guildId)) {
      throw new Error('IDLE_MMO_GUILD_ID is missing or not a single path segment');
    }
    path = path.replace('{id}', guildId);
  }
  assertDocumentedPath(path);
  return path;
}

/** Reject anything that is not an exact resolved path from the official catalog. */
export function assertDocumentedPath(path: string): void {
  if (
    !path.startsWith('/v1/') ||
    path.includes('..') ||
    path.includes('//') ||
    path.includes('?') ||
    path.includes('#')
  ) {
    throw new Error('Refusing non-public Public API path');
  }
  for (const endpoint of DOCUMENTED_ENDPOINTS) {
    if (!endpoint.path) continue;
    if (!endpoint.guildId) {
      if (endpoint.path === path) return;
      continue;
    }
    const [prefix, suffix] = endpoint.path.split('{id}');
    if (!prefix || suffix === undefined) continue;
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
    const id = path.slice(prefix.length, path.length - suffix.length);
    if (GUILD_ID_PATTERN.test(id)) return;
  }
  throw new Error('Refusing Public API path that is not in the official catalog');
}
