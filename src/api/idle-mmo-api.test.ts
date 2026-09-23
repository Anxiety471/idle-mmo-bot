import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertDocumentedPath,
  DOCUMENTED_ENDPOINTS,
  plannedRefreshRequests,
  resolveDocumentedPath,
} from './documented-endpoints.js';
import {
  DEFAULT_PUBLIC_API_ORIGIN,
  formatPublicApiLog,
  IdleMmoPublicApi,
  loadIdleMmoApiConfig,
  parseApiBaseUrl,
  parseRateLimitReset,
  PUBLIC_API_USER_AGENT,
  type FetchLike,
  type IdleMmoApiConfig,
} from './idle-mmo-api.js';
import {
  mapCharacterInformation,
  mapCurrentActionPayload,
  mapIdentityPayload,
  mapInventoryPayload,
  mapLocationsPayload,
  mapPetsPayload,
} from './map-public-api.js';
import { minSafeIntervalMs, PUBLIC_API_MAX_PER_MINUTE, SlidingWindowRateLimiter } from './rate-limit.js';

const OFFICIAL_PATHS = [
  '/v1/auth/check',
  '/v1/world/locations/list',
  '/v1/combat/world_bosses/list',
  '/v1/combat/dungeons/list',
  '/v1/combat/enemies/list',
  '/v1/item/search',
  '/v1/item/{hashed_item_id}/inspect',
  '/v1/item/{hashed_item_id}/market-history',
  '/v1/character/{hashed_character_id}/information',
  '/v1/character/{hashed_character_id}/metrics',
  '/v1/character/{hashed_character_id}/effects',
  '/v1/character/{hashed_character_id}/characters',
  '/v1/character/{hashed_character_id}/museum',
  '/v1/character/{hashed_character_id}/current-action',
  '/v1/character/{hashed_character_id}/pets',
  '/v1/pets/companion-exchange/listings',
  '/v1/guild/{id}/information',
  '/v1/guild/{id}/members',
  '/v1/guild/{id}/activity',
  '/v1/guild/{id}/energizing-pool/information',
  '/v1/guild/{id}/hall',
  '/v1/guild/conquest/view',
  '/v1/guild/conquest/zone/{zone_id}/inspect',
  '/v1/shrine/progress',
] as const;

function config(overrides: Partial<IdleMmoApiConfig> = {}): IdleMmoApiConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.example.test',
    userAgent: PUBLIC_API_USER_AGENT,
    minIntervalMs: 0,
    maxPerMinute: PUBLIC_API_MAX_PER_MINUTE,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function informationBody() {
  return {
    character: {
      id: 1,
      hashed_id: 'heroHash',
      name: 'Hero',
      class: 'Miner',
      skills: {
        mining: { experience: 120, level: 8 },
        fishing: { experience: 10, level: 2 },
      },
      stats: { strength: 9 },
      gold: 1500,
      tokens: 3,
      shards: 4,
      total_level: 22,
      location: { id: 4, name: 'Bluebell Hollow' },
      equipped_pet: {
        id: 9,
        name: 'Rock Pup',
        custom_name: 'Pebble',
        quality: 'common',
        evolution: 1,
        hunger: 3,
      },
      current_status: 'idle',
    },
  };
}

function actionBody() {
  return {
    type: 'MINING',
    item: 'Iron Ore',
    image_url: 'https://cdn.example/ore.png',
    title: 'Mining Iron Ore',
    started_at: '2026-09-23T00:00:00Z',
    expires_at: '2026-09-23T00:01:00Z',
  };
}

describe('documented public API catalog', { concurrency: 1 }, () => {
  it('lists the 24 official paths and refuses inventory or invented routes', () => {
    assert.equal(DOCUMENTED_ENDPOINTS.length, 24);
    assert.deepEqual(
      DOCUMENTED_ENDPOINTS.map((endpoint) => endpoint.path),
      [...OFFICIAL_PATHS],
    );
    for (const endpoint of DOCUMENTED_ENDPOINTS) {
      assert.match(endpoint.path, /^\/v1\//);
      assert.equal(endpoint.method, 'GET');
      assert.equal(endpoint.path.toLowerCase().includes('inventory'), false);
    }
    assert.equal(
      DOCUMENTED_ENDPOINTS.find((endpoint) => endpoint.id === 'character-information')?.scopes[0],
      'v1.character.view',
    );
    assert.equal(
      DOCUMENTED_ENDPOINTS.find((endpoint) => endpoint.id === 'current-action')?.scopes[0],
      'v1.character.current_action',
    );
    assert.equal(
      DOCUMENTED_ENDPOINTS.find((endpoint) => endpoint.id === 'character-pets')?.scopes[0],
      'v1.character.pets',
    );
    assert.doesNotThrow(() => assertDocumentedPath('/v1/auth/check'));
    assert.doesNotThrow(() => assertDocumentedPath('/v1/world/locations/list'));
    assert.doesNotThrow(() =>
      assertDocumentedPath(
        resolveDocumentedPath(
          DOCUMENTED_ENDPOINTS.find((endpoint) => endpoint.id === 'guild-hall')!,
          { guildId: 'guild_1' },
        ),
      ),
    );
    assert.doesNotThrow(() =>
      assertDocumentedPath(
        resolveDocumentedPath(
          DOCUMENTED_ENDPOINTS.find((endpoint) => endpoint.id === 'character-information')!,
          { characterId: 'heroHash' },
        ),
      ),
    );
    assert.doesNotThrow(() => assertDocumentedPath('/v1/item/itemHash/inspect'));
    assert.doesNotThrow(() => assertDocumentedPath('/v1/guild/conquest/zone/zone1/inspect'));
    assert.throws(() => assertDocumentedPath('/api/internal/inventory'));
    assert.throws(() => assertDocumentedPath('/v1/character/heroHash/inventory'));
    assert.throws(() => assertDocumentedPath('/v1/inventory'));
    assert.throws(() => assertDocumentedPath('/v1/character'));
    assert.throws(() => assertDocumentedPath('/v1/auth/check/../admin'));
    assert.equal(plannedRefreshRequests(true), 3);
    assert.equal(plannedRefreshRequests(false), 5);
    assert.deepEqual(
      DOCUMENTED_ENDPOINTS.filter((endpoint) => endpoint.refresh !== 'off').map((endpoint) => endpoint.id),
      [
        'auth-check',
        'character-information',
        'character-characters',
        'current-action',
        'character-pets',
      ],
    );
  });

  it('keeps the local budget under 20 requests per minute', () => {
    const three = minSafeIntervalMs(plannedRefreshRequests(true));
    const five = minSafeIntervalMs(plannedRefreshRequests(false));
    assert.ok((3 * 60_000) / three <= PUBLIC_API_MAX_PER_MINUTE - 2);
    assert.ok((5 * 60_000) / five <= PUBLIC_API_MAX_PER_MINUTE - 2);
  });
});

describe('SlidingWindowRateLimiter', () => {
  it('allows 20 calls in a minute and blocks the next', () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowRateLimiter(20, () => now);
    for (let i = 0; i < 20; i++) assert.equal(limiter.tryTake(), true);
    assert.equal(limiter.tryTake(), false);
    now += 60_001;
    assert.equal(limiter.tryTake(), true);
  });
});

describe('IdleMmo API config', () => {
  it('stays disabled without a key and defaults the origin', () => {
    assert.deepEqual(loadIdleMmoApiConfig({}), { enabled: false, reason: 'missing-key' });
    const loaded = loadIdleMmoApiConfig({ IDLE_MMO_API_KEY: 'test-key' });
    assert.equal(loaded.enabled, true);
    if (loaded.enabled) {
      assert.equal(loaded.config.baseUrl, DEFAULT_PUBLIC_API_ORIGIN);
      assert.equal(loaded.config.baseUrl, 'https://api.idle-mmo.com');
    }
    assert.throws(() => parseApiBaseUrl('http://api.example.test'));
    assert.throws(() => parseApiBaseUrl('https://api.example.test/v1'));
    assert.equal(parseApiBaseUrl('https://api.example.test/'), 'https://api.example.test');
    const invalid = loadIdleMmoApiConfig({
      IDLE_MMO_API_KEY: 'test-key',
      IDLE_MMO_API_BASE: 'http://insecure.example',
    });
    assert.equal(invalid.enabled, false);
    if (!invalid.enabled) assert.equal(invalid.reason, 'missing-base');
  });

  it('drops a guild id or character hash that could change the path', () => {
    const loaded = loadIdleMmoApiConfig({
      IDLE_MMO_API_KEY: 'test-key',
      IDLE_MMO_API_BASE: 'https://api.example.test',
      IDLE_MMO_GUILD_ID: '../admin',
      IDLE_MMO_CHARACTER_HASHED_ID: 'hero/../admin',
    });
    assert.equal(loaded.enabled, true);
    if (loaded.enabled) {
      assert.equal(loaded.config.guildId, undefined);
      assert.equal(loaded.config.characterHashedId, undefined);
    }
    const explicit = loadIdleMmoApiConfig({
      IDLE_MMO_API_KEY: 'test-key',
      IDLE_MMO_CHARACTER_HASHED_ID: 'heroHash',
    });
    assert.equal(explicit.enabled, true);
    if (explicit.enabled) assert.equal(explicit.config.characterHashedId, 'heroHash');
  });
});

describe('IdleMmoPublicApi', { concurrency: 1 }, () => {
  it('refreshes information, current-action, and pets when the character hash is set', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/information')) return jsonResponse(informationBody());
      if (url.endsWith('/current-action')) return jsonResponse(actionBody());
      if (url.endsWith('/pets')) {
        return jsonResponse({
          pets: [
            {
              id: 9,
              name: 'Rock Pup',
              custom_name: 'Pebble',
              pet_id: 8,
              level: 4,
              experience: 10,
              total_experience: 99,
              quality: 'common',
              stats: { attack: 1 },
              health: 20,
              happiness: 5,
              equipped: true,
              hunger: 9,
            },
          ],
        });
      }
      return jsonResponse({ unexpected: url }, 500);
    };
    const api = new IdleMmoPublicApi(
      config({
        characterHashedId: 'heroHash',
        characterName: 'Hero',
        guildId: 'guild_1',
        minIntervalMs: 60_000,
      }),
      { fetchImpl, now: () => 5_000 },
    );
    const read = await api.read();
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://api.example.test/v1/character/heroHash/information',
        'https://api.example.test/v1/character/heroHash/current-action',
        'https://api.example.test/v1/character/heroHash/pets',
      ],
    );
    assert.equal(
      calls.some((call) => /inventory|\/item\/|\/combat\/|\/guild\//.test(call.url)),
      false,
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(headers['User-Agent'], PUBLIC_API_USER_AGENT);
    assert.equal(headers.Accept, 'application/json');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal(read.ok, true);
    assert.equal(read.patch.gold, 1500);
    assert.equal(read.patch.tokens, 3);
    assert.equal(read.patch.totalLevel, 22);
    assert.equal(read.patch.skillLevels?.mining, 8);
    assert.equal(read.patch.skillLevels?.fishing, 2);
    assert.equal(read.patch.location, 'Bluebell Hollow');
    assert.equal(read.patch.combatLevel, undefined);
    assert.equal(read.patch.inventory, undefined);
    assert.equal(read.patch.combatPhase, undefined);
    assert.equal(read.patch.identity?.hashedId, 'heroHash');
    assert.deepEqual(read.patch.identity?.names, ['Hero']);
    assert.equal(read.patch.identity?.currentStatus, 'idle');
    assert.deepEqual(read.patch.equippedPet, {
      id: 9,
      name: 'Rock Pup',
      custom_name: 'Pebble',
      quality: 'common',
      evolution: 1,
    });
    assert.equal(read.patch.currentAction?.busy, true);
    assert.equal(read.patch.currentAction?.type, 'MINING');
    assert.equal(read.patch.currentAction?.skill, 'mining');
    assert.equal(read.patch.currentAction?.resource, 'Iron Ore');
    assert.equal(read.patch.currentAction?.label, 'Mining Iron Ore');
    assert.equal(read.patch.currentAction?.startedAt, '2026-09-23T00:00:00Z');
    assert.equal(read.patch.currentAction?.expiresAt, '2026-09-23T00:01:00Z');
    assert.equal(JSON.stringify(read.patch.currentAction).includes('image_url'), false);
    assert.equal(JSON.stringify(read.patch.currentAction).includes('cdn.example'), false);
    assert.equal(read.patch.pets?.[0]?.happiness, 5);
    assert.equal(JSON.stringify(read.patch.pets).includes('hunger'), false);
    assert.equal(JSON.stringify(read).includes('test-key'), false);
    assert.equal(JSON.stringify(read.patch).includes('shards'), false);

    const again = await api.read();
    assert.equal(again.fromCache, true);
    assert.equal(calls.length, 3);
  });

  it('resolves hashed_character_id from auth/check using CHARACTER_NAME', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/v1/auth/check')) {
        return jsonResponse({
          characters: [
            { name: 'Other', hashed_id: 'otherHash' },
            { name: 'Hero', hashed_id: 'heroHash', online_status: 'online' },
          ],
        });
      }
      if (url.endsWith('/information')) return jsonResponse(informationBody());
      if (url.endsWith('/current-action')) return jsonResponse({ type: null });
      return jsonResponse({ pets: [] });
    };
    const api = new IdleMmoPublicApi(
      config({ characterName: 'Hero', minIntervalMs: 60_000 }),
      { fetchImpl, now: () => 10 },
    );
    const read = await api.read();
    assert.deepEqual(calls, [
      'https://api.example.test/v1/auth/check',
      'https://api.example.test/v1/character/heroHash/information',
      'https://api.example.test/v1/character/heroHash/current-action',
      'https://api.example.test/v1/character/heroHash/pets',
    ]);
    assert.equal(calls.some((url) => url.endsWith('/characters')), false);
    assert.equal(read.patch.identity?.hashedId, 'heroHash');
    assert.equal(read.patch.identity?.onlineStatus, 'online');
    assert.equal(read.patch.currentAction?.busy, false);
    assert.equal(read.patch.inventory, undefined);
  });

  it('falls back to alt characters when auth/check has no name match', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/v1/auth/check')) return jsonResponse({ user: { hashed_id: 'acctHash' } });
      if (url.endsWith('/v1/character/acctHash/characters')) {
        return jsonResponse({
          characters: [
            { name: 'Alt', hashed_id: 'altHash' },
            { name: 'Hero', hashed_id: 'heroHash' },
          ],
        });
      }
      if (url.endsWith('/information')) return jsonResponse({ hashed_id: 'heroHash', name: 'Hero', gold: 10 });
      if (url.endsWith('/current-action')) return jsonResponse({});
      return jsonResponse({ pets: [{ name: 'Pip', level: 1 }] });
    };
    const api = new IdleMmoPublicApi(config({ characterName: 'Hero' }), {
      fetchImpl,
      now: () => 20,
    });
    const read = await api.read();
    assert.deepEqual(calls, [
      'https://api.example.test/v1/auth/check',
      'https://api.example.test/v1/character/acctHash/characters',
      'https://api.example.test/v1/character/heroHash/information',
      'https://api.example.test/v1/character/heroHash/current-action',
      'https://api.example.test/v1/character/heroHash/pets',
    ]);
    assert.equal(read.patch.gold, 10);
    assert.equal(read.patch.identity?.hashedId, 'heroHash');
    assert.equal(read.patch.currentAction?.busy, false);
    assert.equal(read.patch.pets?.[0]?.name, 'Pip');
  });

  it('skips optional pets when the local budget is already spent', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/information')) return jsonResponse({ gold: 1, hashed_id: 'heroHash', name: 'Hero' });
      if (url.endsWith('/current-action')) return jsonResponse(actionBody());
      return jsonResponse({ pets: [{ name: 'Should Not Load' }] });
    };
    const api = new IdleMmoPublicApi(
      config({ characterHashedId: 'heroHash', maxPerMinute: 2 }),
      { fetchImpl, now: () => 30 },
    );
    const read = await api.read();
    assert.deepEqual(calls, [
      'https://api.example.test/v1/character/heroHash/information',
      'https://api.example.test/v1/character/heroHash/current-action',
    ]);
    assert.equal(read.patch.pets, undefined);
    assert.equal(read.meta.petsSkipped, 'budget');
    assert.equal(read.patch.currentAction?.busy, true);
  });

  it('does not request guild, item, or combat catalog routes', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse({ ok: true });
    };
    const api = new IdleMmoPublicApi(
      config({ guildId: 'guild_1', characterHashedId: 'heroHash', minIntervalMs: 60_000 }),
      { fetchImpl, now: () => 40 },
    );
    const read = await api.read();
    assert.equal(calls.length, 3);
    assert.equal(calls.some((url) => url.includes('/guild/')), false);
    assert.equal(calls.some((url) => url.includes('/item/')), false);
    assert.equal(calls.some((url) => url.includes('/combat/')), false);
    assert.equal(read.patch.inventory, undefined);
    assert.equal(read.meta.guild, undefined);
  });

  it('reports 401 without calling further routes or echoing the key', async () => {
    const secret = 'super-secret-key';
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse({ token: secret }, 401);
    };
    const api = new IdleMmoPublicApi(config({ apiKey: secret }), { fetchImpl, now: () => 1 });
    const read = await api.read();
    assert.deepEqual(calls, ['https://api.example.test/v1/auth/check']);
    assert.equal(read.ok, false);
    assert.equal(read.errors[0]?.code, 'unauthorized');
    assert.equal(JSON.stringify(read).includes(secret), false);
    assert.equal(read.patch.inventory, undefined);
  });

  it('stops after 429 and serves the cached failure instead of retrying', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ error: 'slow down' }, 429, { 'x-ratelimit-reset': '30' });
    };
    let now = 10_000;
    const api = new IdleMmoPublicApi(config(), { fetchImpl, now: () => now });
    const first = await api.read();
    assert.equal(first.errors[0]?.code, 'rate-limited');
    assert.equal(calls, 1);
    now += 1_000;
    const second = await api.read();
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1);
  });

  it('redacts the key from network errors', async () => {
    const secret = 'super-secret-key';
    const fetchImpl: FetchLike = async () => {
      throw new Error(`connect ${secret}`);
    };
    const api = new IdleMmoPublicApi(config({ apiKey: secret }), { fetchImpl, now: () => 1 });
    const read = await api.read();
    assert.equal(read.errors[0]?.code, 'network');
    assert.equal(read.errors[0]?.message.includes(secret), false);
  });

  it('refuses redirects', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.test/internal' } });
    const api = new IdleMmoPublicApi(config(), { fetchImpl, now: () => 1 });
    const read = await api.read();
    assert.equal(read.errors[0]?.code, 'http');
    assert.equal(read.endpointsUsed.length, 0);
  });
});

describe('payload mappers', () => {
  it('maps locations, identity, inventory quantities, and pet example fields', () => {
    const locations = mapLocationsPayload([
      { name: 'Whispering Woods', current: false },
      { name: 'Bluebell Hollow', current: true, weather: { name: 'Fog' } },
    ]);
    assert.equal(locations.location, 'Bluebell Hollow');
    assert.equal(locations.weather, 'Fog');

    const identity = mapIdentityPayload({
      user: { hashed_id: 'user-1', name: 'Account' },
      last_activity: '2020-01-01',
    });
    assert.equal(identity.hashedId, 'user-1');
    assert.deepEqual(identity.names, ['Account']);
    assert.equal(JSON.stringify(identity).includes('2020'), false);

    assert.deepEqual(
      mapInventoryPayload({
        items: [
          { name: 'Cooked Cod', quantity: 40 },
          { name: 'Raw Cod', quantity: 3 },
          { name: 'Coal', quantity: 15 },
          { name: 'Cheap Bait', quantity: 2 },
        ],
      }),
      { 'Cooked Cod': 40, 'Raw Cod': 3, Coal: 15, 'Cheap Bait': 2 },
    );
    assert.equal(mapInventoryPayload({ weather: 'Clear' }), undefined);
    assert.deepEqual(
      mapPetsPayload({ pets: [{ total_experience: 10, happiness: 1, hunger: 2, name: 'Pip' }] }),
      [{ total_experience: 10, happiness: 1, name: 'Pip' }],
    );
  });

  it('maps character information and current action without battle or bag fields', () => {
    const info = mapCharacterInformation(informationBody());
    assert.equal(info.gold, 1500);
    assert.equal(info.totalLevel, 22);
    assert.equal(info.skillLevels?.mining, 8);
    assert.equal(info.location, 'Bluebell Hollow');
    assert.equal(info.inventory, undefined);
    assert.equal(info.combatPhase, undefined);
    assert.equal(JSON.stringify(info).includes('strength'), false);

    const mining = mapCurrentActionPayload(actionBody());
    assert.equal(mining?.busy, true);
    assert.equal(mining?.skill, 'mining');
    assert.equal(JSON.stringify(mining).includes('image_url'), false);
    assert.deepEqual(mapCurrentActionPayload({}), { busy: false });
    assert.equal(mapCurrentActionPayload({ error: 'nope' }), undefined);
  });

  it('parses X-RateLimit-Reset as a delta or unix time', () => {
    assert.equal(parseRateLimitReset('15', 5_000), 20_000);
    assert.equal(parseRateLimitReset('1700000000', 0), 1_700_000_000_000);
    assert.equal(parseRateLimitReset(undefined, 0), undefined);
  });

  it('logs the refresh without claiming an inventory overlay', () => {
    const line = formatPublicApiLog({
      ok: true,
      fromCache: false,
      fetchedAt: 1,
      endpointsUsed: ['character-information', 'current-action', 'character-pets'],
      errors: [],
      unavailable: [],
      patch: { inventory: { 'Cooked Cod': 4, Coal: 1 }, gold: 10 },
      meta: {},
    });
    assert.match(line ?? '', /inventory remains Playwright scrape/);
    assert.equal(line?.includes('inventory applied'), false);
    assert.equal(line?.includes('test-key'), false);

    const unresolved = formatPublicApiLog({
      ok: true,
      fromCache: false,
      fetchedAt: 1,
      endpointsUsed: ['auth-check'],
      errors: [{ id: 'character-information', code: 'missing-character-id', message: 'unresolved' }],
      unavailable: [],
      patch: {},
      meta: {},
    });
    assert.match(unresolved ?? '', /Playwright scrape/);
    assert.match(unresolved ?? '', /missing-character-id/);
    assert.equal(
      formatPublicApiLog({
        ok: true,
        fromCache: true,
        fetchedAt: 1,
        endpointsUsed: ['auth-check'],
        errors: [],
        unavailable: [],
        patch: {},
        meta: {},
      }),
      undefined,
    );
  });
});
