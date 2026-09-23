import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertDocumentedPath,
  DOCUMENTED_ENDPOINTS,
  resolveDocumentedPath,
} from './documented-endpoints.js';
import {
  formatPublicApiLog,
  IdleMmoPublicApi,
  loadIdleMmoApiConfig,
  parseApiBaseUrl,
  parseRateLimitReset,
  PUBLIC_API_USER_AGENT,
  type FetchLike,
  type IdleMmoApiConfig,
} from './idle-mmo-api.js';
import { mapIdentityPayload, mapInventoryPayload, mapLocationsPayload, mapPetsPayload } from './map-public-api.js';
import { minSafeIntervalMs, PUBLIC_API_MAX_PER_MINUTE, SlidingWindowRateLimiter } from './rate-limit.js';

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

describe('documented public API catalog', { concurrency: 1 }, () => {
  it('only allows official /v1 paths and refuses invented routes', () => {
    for (const endpoint of DOCUMENTED_ENDPOINTS) {
      if (endpoint.path) {
        assert.match(endpoint.path, /^\/v1\//);
        assert.equal(endpoint.method, 'GET');
      }
    }
    assert.doesNotThrow(() => assertDocumentedPath('/v1/auth/check'));
    assert.doesNotThrow(() => assertDocumentedPath('/v1/world/locations/list'));
    assert.doesNotThrow(() =>
      assertDocumentedPath(resolveDocumentedPath(
        DOCUMENTED_ENDPOINTS.find((endpoint) => endpoint.id === 'guild-hall')!,
        'guild_1',
      )),
    );
    assert.throws(() => assertDocumentedPath('/api/internal/inventory'));
    assert.throws(() => assertDocumentedPath('/v1/character'));
    assert.throws(() => assertDocumentedPath('/v1/inventory'));
    assert.throws(() => assertDocumentedPath('/v1/auth/check/../admin'));
    assert.equal(
      DOCUMENTED_ENDPOINTS.some((endpoint) => endpoint.path === '/v1/quests'),
      false,
    );
  });

  it('keeps the local budget under 20 requests per minute', () => {
    const two = minSafeIntervalMs(2);
    const five = minSafeIntervalMs(5);
    assert.ok(two >= Math.ceil((2 * 60_000) / (PUBLIC_API_MAX_PER_MINUTE - 2)));
    assert.ok((2 * 60_000) / two <= PUBLIC_API_MAX_PER_MINUTE - 2);
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
  it('stays disabled without a key and does not invent a host', () => {
    assert.deepEqual(loadIdleMmoApiConfig({}), { enabled: false, reason: 'missing-key' });
    const missingBase = loadIdleMmoApiConfig({ IDLE_MMO_API_KEY: 'test-key' });
    assert.equal(missingBase.enabled, false);
    if (!missingBase.enabled) {
      assert.equal(missingBase.reason, 'missing-base');
      assert.match(missingBase.message ?? '', /IDLE_MMO_API_BASE/);
    }
    assert.throws(() => parseApiBaseUrl('http://api.example.test'));
    assert.throws(() => parseApiBaseUrl('https://api.example.test/v1'));
    assert.equal(parseApiBaseUrl('https://api.example.test/'), 'https://api.example.test');
  });

  it('drops a guild id that could change the path', () => {
    const loaded = loadIdleMmoApiConfig({
      IDLE_MMO_API_KEY: 'test-key',
      IDLE_MMO_API_BASE: 'https://api.example.test',
      IDLE_MMO_GUILD_ID: '../admin',
    });
    assert.equal(loaded.enabled, true);
    if (loaded.enabled) assert.equal(loaded.config.guildId, undefined);
  });
});

describe('IdleMmoPublicApi', { concurrency: 1 }, () => {
  it('calls only documented routes with bearer auth and the custom user agent', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/auth/check')) {
        return jsonResponse({
          characters: [{ name: 'Hero', hashed_id: 'abc123', online_status: 'online' }],
        });
      }
      return jsonResponse({
        locations: [{ name: 'Bluebell Hollow', current: true, weather: 'Clear' }],
      });
    };
    const api = new IdleMmoPublicApi(
      config({ characterName: 'Hero', minIntervalMs: 60_000 }),
      { fetchImpl, now: () => 5_000 },
    );
    const read = await api.read();
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://api.example.test/v1/auth/check',
        'https://api.example.test/v1/world/locations/list',
      ],
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(headers['User-Agent'], PUBLIC_API_USER_AGENT);
    assert.equal(headers.Accept, 'application/json');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal(read.ok, true);
    assert.equal(read.patch.location, 'Bluebell Hollow');
    assert.equal(read.patch.zones?.[0]?.name, 'Bluebell Hollow');
    assert.equal(read.patch.weather, 'Clear');
    assert.equal(read.patch.identity?.hashedId, 'abc123');
    assert.equal(read.patch.identity?.onlineStatus, 'online');
    assert.deepEqual(read.patch.identity?.names, ['Hero']);
    assert.equal(read.patch.inventory, undefined);
    assert.ok(read.unavailable.some((resource) => resource.id === 'inventory'));
    assert.ok(read.unavailable.some((resource) => resource.id === 'current-action'));
    assert.equal(JSON.stringify(read).includes('test-key'), false);

    const again = await api.read();
    assert.equal(again.fromCache, true);
    assert.equal(calls.length, 2);
  });

  it('does not copy guild hall stockpiles onto character inventory', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/hall')) {
        return jsonResponse({
          stockpile: [{ name: 'Cooked Cod', quantity: 250 }],
        });
      }
      return jsonResponse({ ok: true });
    };
    const api = new IdleMmoPublicApi(config({ guildId: 'guild_1', minIntervalMs: 60_000 }), {
      fetchImpl,
      now: () => 10,
    });
    const read = await api.read();
    assert.equal(calls.length, 5);
    assert.ok(calls.every((url) => url.startsWith('https://api.example.test/v1/')));
    assert.ok(calls.some((url) => url.endsWith('/v1/guild/guild_1/hall')));
    assert.equal(read.patch.inventory, undefined);
    const guild = read.meta.guild as { 'guild-hall'?: { stockpile?: unknown[] } };
    assert.equal(guild['guild-hall']?.stockpile?.length, 1);
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
  it('maps locations, identity, inventory quantities, and pet experience', () => {
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
    assert.deepEqual(mapPetsPayload({ pets: [{ total_experience: 10, happiness: 1 }] }), [
      { total_experience: 10 },
    ]);
  });

  it('parses X-RateLimit-Reset as a delta or unix time', () => {
    assert.equal(parseRateLimitReset('15', 5_000), 20_000);
    assert.equal(parseRateLimitReset('1700000000', 0), 1_700_000_000_000);
    assert.equal(parseRateLimitReset(undefined, 0), undefined);
  });

  it('logs an inventory line without secrets and a soft-fail when inventory is unpublished', () => {
    const inventoryLine = formatPublicApiLog({
      ok: true,
      fromCache: false,
      fetchedAt: 1,
      endpointsUsed: ['inventory'],
      errors: [],
      unavailable: [],
      patch: { inventory: { 'Cooked Cod': 4, Coal: 1 } },
      meta: {},
    });
    assert.equal(inventoryLine, '[snapshot] Public API inventory applied (2 items)');

    const unpublished = formatPublicApiLog({
      ok: true,
      fromCache: false,
      fetchedAt: 1,
      endpointsUsed: ['auth-check', 'world-locations'],
      errors: [],
      unavailable: [],
      patch: {},
      meta: {},
    });
    assert.match(unpublished ?? '', /unpublished/);
    assert.equal(unpublished?.includes('test-key'), false);
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
