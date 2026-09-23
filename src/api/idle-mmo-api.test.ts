import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DOCUMENTED_PATHS,
  IDLE_MMO_BOT_USER_AGENT,
  IdleMmoApiClient,
  IdleMmoApiError,
  inventoryQuantitiesFromUnknown,
  isSafeV1Path,
  loadIdleMmoApiConfig,
  parseAuthCheck,
  parseCharacterInformation,
  parseCurrentAction,
  type IdleMmoClock,
} from './idle-mmo-api.js';

const API_KEY = 'test-key-not-real';

function clockAt(start = 1_000_000): { clock: IdleMmoClock; sleeps: number[] } {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('loadIdleMmoApiConfig', () => {
  it('stays disabled when IDLE_MMO_API_KEY is missing', () => {
    assert.equal(loadIdleMmoApiConfig({}), null);
  });

  it('defaults the host to api.idle-mmo.com and strips a trailing /v1', () => {
    const config = loadIdleMmoApiConfig({
      IDLE_MMO_API_KEY: API_KEY,
      IDLE_MMO_API_BASE: 'https://api.idle-mmo.com/v1/',
    });
    assert.equal(config?.baseUrl, 'https://api.idle-mmo.com');
    assert.equal(config?.userAgent, IDLE_MMO_BOT_USER_AGENT);
    assert.equal(config?.minIntervalMs, 3_000);
  });

  it('rejects inventory paths that are not documented /v1/ routes', () => {
    assert.equal(isSafeV1Path('/v1/auth/check'), true);
    assert.equal(isSafeV1Path('/internal/inventory'), false);
    assert.equal(isSafeV1Path('/v1/../admin'), false);
    assert.throws(
      () =>
        loadIdleMmoApiConfig({
          IDLE_MMO_API_KEY: API_KEY,
          IDLE_MMO_INVENTORY_PATH: 'https://example.invalid/steal',
        }),
      (error: unknown) => error instanceof IdleMmoApiError && error.code === 'bad_response',
    );
  });
});

describe('response parsers', () => {
  it('parses auth check without keeping a secret', () => {
    const auth = parseAuthCheck({
      authenticated: true,
      character: { hashed_id: 'abc123', name: 'IdleBocchi', total_level: 12 },
      api_key: {
        name: 'autopilot',
        rate_limit: 20,
        scopes: ['v1.auth.check', 'v1.character.view'],
        expires_at: null,
      },
    });
    assert.equal(auth.authenticated, true);
    assert.equal(auth.character?.hashedId, 'abc123');
    assert.equal(auth.character?.name, 'IdleBocchi');
    assert.equal(auth.rateLimit, 20);
    assert.deepEqual(auth.scopes, ['v1.auth.check', 'v1.character.view']);
    assert.equal(JSON.stringify(auth).includes(API_KEY), false);
  });

  it('maps character skills, gold, and an embedded item list', () => {
    const character = parseCharacterInformation({
      character: {
        name: 'IdleBocchi',
        hashed_id: 'abc123',
        gold: 900,
        tokens: 3,
        total_level: 20,
        location: { id: 1, name: 'Bluebell Hollow' },
        skills: {
          mining: { level: 8, experience: 100 },
          cooking: { level: 4, experience: 10 },
          combat: { level: 6, experience: 50 },
        },
        inventory: [
          { name: 'Cooked Cod', quantity: 40 },
          { name: 'Coal', quantity: 15 },
          { name: 'Cod', quantity: 12 },
          { item_name: 'Cheap Bait', qty: 2 },
        ],
      },
    });
    assert.equal(character.gold, 900);
    assert.equal(character.location, 'Bluebell Hollow');
    assert.equal(character.skillLevels.mining, 8);
    assert.equal(character.skillLevels.cooking, 4);
    assert.equal(character.combatLevel, 6);
    assert.equal(character.inventory?.['Cooked Cod'], 40);
    assert.equal(character.inventory?.['Coal Ore'], 15);
    assert.equal(character.inventory?.['Raw Cod'], 12);
    assert.equal(character.inventory?.['Cheap Bait'], 2);
    assert.equal(character.inventory?.Coal, undefined);
    assert.equal(character.inventory?.Cod, undefined);
  });

  it('returns null inventory when the character payload has no item list', () => {
    const character = parseCharacterInformation({
      character: { name: 'IdleBocchi', skills: { fishing: { level: 2, experience: 1 } } },
    });
    assert.equal(character.inventory, null);
    assert.equal(character.skillLevels.fishing, 2);
  });

  it('parses current action and treats an explicit null action as idle', () => {
    const busy = parseCurrentAction({
      type: 'mining',
      item: 'Coal Ore',
      title: 'Mining',
      started_at: '2026-09-23T00:00:00Z',
    });
    assert.equal(busy?.busy, true);
    assert.equal(busy?.skill, 'mining');
    assert.equal(busy?.resource, 'Coal Ore');
    assert.equal(parseCurrentAction({ current_action: null }), undefined);
  });

  it('accepts wrapped inventory collections and rejects unknown shapes', () => {
    assert.deepEqual(
      inventoryQuantitiesFromUnknown({
        data: { items: [{ name: 'Cooked Cod', quantity: '1.2K' }] },
      }),
      { 'Cooked Cod': 1200 },
    );
    assert.deepEqual(inventoryQuantitiesFromUnknown({ items: [] }), {});
    assert.equal(inventoryQuantitiesFromUnknown({ message: 'nope' }), null);
  });
});

describe('IdleMmoApiClient', () => {
  const authBody = {
    authenticated: true,
    character: { hashed_id: 'abc123', name: 'IdleBocchi', total_level: 12 },
    api_key: { name: 'autopilot', rate_limit: 20, scopes: ['v1.auth.check'] },
  };
  const characterBody = {
    character: {
      name: 'IdleBocchi',
      hashed_id: 'abc123',
      gold: 10,
      total_level: 12,
      skills: { woodcutting: { level: 3, experience: 1 } },
    },
  };
  const actionBody = { type: 'cooking', item: 'Cooked Cod', title: 'Cooking' };

  function clientFor(
    handler: (url: string, init?: RequestInit) => Response,
    extra?: { inventoryPath?: string; characterId?: string },
  ) {
    const { clock, sleeps } = clockAt();
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    };
    const client = new IdleMmoApiClient(
      {
        apiKey: API_KEY,
        baseUrl: 'https://api.idle-mmo.com',
        userAgent: IDLE_MMO_BOT_USER_AGENT,
        minIntervalMs: 3_000,
        cacheTtlMs: 30_000,
        characterId: extra?.characterId,
        inventoryPath: extra?.inventoryPath,
      },
      fetchImpl,
      clock,
    );
    return { client, calls, sleeps };
  }

  it('sends bearer auth and the bot user-agent, and never puts the key in the URL', async () => {
    const { client, calls, sleeps } = clientFor((url) => {
      if (url.endsWith(DOCUMENTED_PATHS.authCheck)) return jsonResponse(200, authBody);
      if (url.endsWith('/v1/character/abc123/information')) return jsonResponse(200, characterBody);
      if (url.endsWith('/v1/character/abc123/current-action')) return jsonResponse(200, actionBody);
      return jsonResponse(404, { error: 'missing' });
    });

    const read = await client.readSnapshot('IdleBocchi');
    assert.equal(read?.skillLevels.woodcutting, 3);
    assert.equal(read?.gold, 10);
    assert.equal(read?.currentAction?.skill, 'cooking');
    assert.equal(read?.inventory, null);
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://api.idle-mmo.com/v1/auth/check',
        'https://api.idle-mmo.com/v1/character/abc123/information',
        'https://api.idle-mmo.com/v1/character/abc123/current-action',
      ],
    );
    for (const call of calls) {
      assert.equal(call.url.includes(API_KEY), false);
      const headers = call.init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
      assert.equal(headers['User-Agent'], IDLE_MMO_BOT_USER_AGENT);
    }
    assert.deepEqual(sleeps, [3_000, 3_000]);
  });

  it('serves a cached auth check even after the rate-limit window is exhausted', async () => {
    const { client, calls } = clientFor(() =>
      jsonResponse(200, authBody, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '9999999999',
      }),
    );
    const first = await client.checkAuth();
    const second = await client.checkAuth();
    assert.equal(first.character?.name, 'IdleBocchi');
    assert.equal(second.character?.name, 'IdleBocchi');
    assert.equal(calls.length, 1);
  });

  it('caches reads so a second snapshot does not call the network', async () => {
    const { client, calls } = clientFor((url) => {
      if (url.endsWith(DOCUMENTED_PATHS.authCheck)) return jsonResponse(200, authBody);
      if (url.includes('/information')) return jsonResponse(200, characterBody);
      return jsonResponse(200, actionBody);
    });
    await client.readSnapshot();
    await client.readSnapshot();
    assert.equal(calls.length, 3);
  });

  it('throws unauthorized on 401 and rate_limited on 429 without another immediate call', async () => {
    const { client, calls } = clientFor(() => jsonResponse(401, { error: 'Unauthorized' }));
    await assert.rejects(() => client.checkAuth(), (error: unknown) => {
      return error instanceof IdleMmoApiError && error.code === 'unauthorized' && error.status === 401;
    });
    await assert.rejects(() => client.checkAuth(), (error: unknown) => {
      return error instanceof IdleMmoApiError && error.code === 'rate_limited';
    });
    assert.equal(calls.length, 1);

    const limited = clientFor(() =>
      jsonResponse(429, { error: 'Too Many Requests' }, { 'retry-after': '30' }),
    );
    await assert.rejects(() => limited.client.checkAuth(), (error: unknown) => {
      return error instanceof IdleMmoApiError && error.code === 'rate_limited' && error.status === 429;
    });
    await assert.rejects(() => limited.client.checkAuth(), (error: unknown) => {
      return error instanceof IdleMmoApiError && error.code === 'rate_limited';
    });
    assert.equal(limited.calls.length, 1);
  });

  it('fetches a configured /v1/ inventory path and skips unknown shapes', async () => {
    const { client, calls } = clientFor(
      (url) => {
        if (url.endsWith(DOCUMENTED_PATHS.authCheck)) return jsonResponse(200, authBody);
        if (url.includes('/information')) return jsonResponse(200, characterBody);
        if (url.includes('/current-action')) return jsonResponse(200, { current_action: null });
        if (url.endsWith('/v1/character/abc123/inventory')) {
          return jsonResponse(200, {
            items: [
              { name: 'Cooked Cod', quantity: 7 },
              { name: 'Raw Cod', quantity: 3 },
            ],
          });
        }
        return jsonResponse(404, {});
      },
      { inventoryPath: '/v1/character/{hashed_character_id}/inventory' },
    );

    const read = await client.readSnapshot('IdleBocchi');
    assert.equal(read?.inventory?.['Cooked Cod'], 7);
    assert.equal(read?.inventory?.['Raw Cod'], 3);
    assert.equal(calls.some((call) => call.url.endsWith('/v1/character/abc123/inventory')), true);
    assert.equal(calls.some((call) => call.url.includes('/internal')), false);
  });

  it('does not request inventory when the path is unset', async () => {
    const { client, calls } = clientFor((url) => {
      if (url.endsWith(DOCUMENTED_PATHS.authCheck)) return jsonResponse(200, authBody);
      if (url.includes('/information')) return jsonResponse(404, {});
      return jsonResponse(404, {});
    });
    const read = await client.readSnapshot();
    assert.equal(read?.inventory, null);
    assert.equal(calls.length, 3);
  });

  it('skips character reads when the API character name does not match', async () => {
    const { client, calls } = clientFor(() => jsonResponse(200, authBody));
    const read = await client.readSnapshot('OtherAlt');
    assert.equal(read?.skipped, 'name_mismatch');
    assert.equal(calls.length, 1);
  });
});
