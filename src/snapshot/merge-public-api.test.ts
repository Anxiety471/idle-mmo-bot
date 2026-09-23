import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IdleMmoPublicApi, PUBLIC_API_USER_AGENT, type FetchLike } from '../api/idle-mmo-api.js';
import type { PublicApiRead } from '../api/public-api-types.js';
import { needsCookBeforeHunt } from '../deterministic/combat.js';
import type { GameSnapshot } from '../types.js';
import { applyPublicApiToSnapshot, mergePublicApiIntoSnapshot } from './merge-public-api.js';

function snapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    location: 'unknown',
    pagePath: '/inventory',
    skillLevels: { mining: 2 },
    inventory: { 'Oak Log': 5, 'Cooked Cod': 0, Cod: 4, 'Coal Ore': 6 },
    acceptedQuests: [{ title: 'Wood for the Hearth', canTurnIn: false, tab: 'accepted' }],
    pendingQuests: [],
    combatPhase: 'none',
    flags: {
      hasBait: false,
      bankNearby: false,
      gatherBusy: false,
      inBattle: false,
      sessionValid: true,
    },
    ...overrides,
  };
}

function read(overrides: Partial<PublicApiRead> = {}): PublicApiRead {
  return {
    ok: true,
    fromCache: false,
    fetchedAt: 123,
    endpointsUsed: ['auth-check'],
    errors: [],
    unavailable: [
      {
        id: 'inventory',
        role: 'inventory',
        reason: 'path-unpublished',
        snapshotFields: ['inventory'],
        summary: 'unpublished',
      },
    ],
    patch: {},
    meta: { authOk: true },
    ...overrides,
  };
}

describe('mergePublicApiIntoSnapshot', () => {
  it('prefers API quantities for overlapping items and keeps DOM-only stacks', () => {
    const merged = mergePublicApiIntoSnapshot(
      snapshot(),
      read({
        endpointsUsed: ['inventory'],
        patch: {
          inventory: {
            'Cooked Cod': 40,
            'Raw Cod': 7,
            Coal: 9,
            'Cheap Bait': 3,
          },
          gold: 1200,
          totalLevel: 15,
          combatLevel: 4,
          skillLevels: { cooking: 3 },
          location: 'Bluebell Hollow',
          zones: [{ name: 'Bluebell Hollow', current: true }],
          weather: 'Clear',
          acceptedQuests: [
            { title: 'Wood for the Hearth', progress: '150/150', canTurnIn: true, tab: 'accepted' },
          ],
          combatPhase: 'battle',
          totalEnemiesFound: 12,
          enemiesRemaining: 3,
          currentAction: { busy: true, skill: 'cooking', label: 'Cod' },
          bankNearby: true,
        },
      }),
    );

    assert.equal(merged.inventory['Cooked Cod'], 40);
    assert.equal(merged.inventory['Raw Cod'], 7);
    assert.equal(merged.inventory.Coal, 9);
    assert.equal(merged.inventory['Cheap Bait'], 3);
    assert.equal(merged.inventory['Oak Log'], 5);
    assert.equal(merged.inventory.Cod, 4);
    assert.equal(merged.inventory['Coal Ore'], 6);
    assert.equal(merged.flags.hasBait, true);
    assert.equal(merged.gold, 1200);
    assert.equal(merged.totalLevel, 15);
    assert.equal(merged.combatLevel, 4);
    assert.equal(merged.skillLevels.cooking, 3);
    assert.equal(merged.skillLevels.mining, 2);
    assert.equal(merged.location, 'Bluebell Hollow');
    assert.equal(merged.acceptedQuests[0]?.canTurnIn, true);
    assert.equal(merged.combatPhase, 'battle');
    assert.equal(merged.flags.inBattle, true);
    assert.equal(merged.flags.gatherBusy, true);
    assert.equal(merged.flags.bankNearby, true);
    assert.equal(merged.flags.sessionValid, true);
    assert.equal(merged.totalEnemiesFound, 12);
    assert.equal(merged.features?.weather, 'Clear');
  });

  it('lets an API zero replace an undercounted DOM stack', () => {
    const merged = mergePublicApiIntoSnapshot(
      snapshot({ inventory: { 'Cooked Cod': 80, Cod: 2, 'Coal Ore': 2 } }),
      read({ patch: { inventory: { 'Cooked Cod': 0 } } }),
    );
    assert.equal(merged.inventory['Cooked Cod'], 0);
    assert.equal(merged.inventory.Cod, 2);
  });

  it('does not treat guild stockpile quantities as character food', () => {
    const dom = snapshot();
    const merged = mergePublicApiIntoSnapshot(
      dom,
      read({
        endpointsUsed: ['guild-hall'],
        meta: { guild: { 'guild-hall': { stockpile: [{ name: 'Cooked Cod', quantity: 500 }] } } },
      }),
    );
    assert.equal(merged.inventory['Cooked Cod'], 0);
    assert.equal(needsCookBeforeHunt(merged.inventory, 100), true);
  });

  it('keeps the cook-before-hunt floor at the caller threshold', () => {
    const under = mergePublicApiIntoSnapshot(
      snapshot(),
      read({
        patch: {
          inventory: { 'Cooked Cod': 99, Cod: 1, 'Coal Ore': 1 },
        },
      }),
    );
    const met = mergePublicApiIntoSnapshot(
      snapshot(),
      read({
        patch: {
          inventory: { 'Cooked Cod': 100, Cod: 1, 'Coal Ore': 1 },
        },
      }),
    );
    assert.equal(needsCookBeforeHunt(under.inventory, 100), true);
    assert.equal(needsCookBeforeHunt(met.inventory, 100), false);
  });

  it('leaves the Playwright snapshot unchanged when the API read has no patch', () => {
    const dom = snapshot({ gold: 10, combatPhase: 'hunt', totalEnemiesFound: 4 });
    const merged = mergePublicApiIntoSnapshot(dom, read());
    assert.equal(merged.gold, 10);
    assert.equal(merged.combatPhase, 'hunt');
    assert.equal(merged.totalEnemiesFound, 4);
    assert.equal(merged.inventory['Oak Log'], 5);
    assert.equal(merged.flags.sessionValid, true);
    const extensions = merged.extensions?.publicApi as { endpointsUsed?: string[] };
    assert.deepEqual(extensions.endpointsUsed, ['auth-check']);
  });
});

describe('applyPublicApiToSnapshot', () => {
  it('does not call the network when the API key is unset', async () => {
    const dom = snapshot();
    const merged = await applyPublicApiToSnapshot(dom, {});
    assert.equal(merged, dom);
  });
});

describe('mocked character route merge', () => {
  it('overlays information and current action without touching bag counts or combat phase', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/information')) {
        return new Response(
          JSON.stringify({
            character: {
              hashed_id: 'heroHash',
              name: 'Hero',
              gold: 1500,
              tokens: 3,
              total_level: 22,
              skills: { mining: { experience: 120, level: 8 }, cooking: { level: 1 } },
              location: { id: 4, name: 'Bluebell Hollow' },
              equipped_pet: { id: 9, name: 'Rock Pup', custom_name: 'Pebble', quality: 'common', evolution: 1 },
              current_status: 'idle',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/current-action')) {
        return new Response(
          JSON.stringify({
            type: 'MINING',
            item: 'Iron Ore',
            image_url: 'https://cdn.example/ore.png',
            title: 'Mining Iron Ore',
            started_at: '2026-09-23T00:00:00Z',
            expires_at: '2026-09-23T00:01:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pets: [{ name: 'Rock Pup', level: 4, equipped: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const api = new IdleMmoPublicApi(
      {
        apiKey: 'test-key',
        baseUrl: 'https://api.example.test',
        userAgent: PUBLIC_API_USER_AGENT,
        characterHashedId: 'heroHash',
        characterName: 'Hero',
        minIntervalMs: 60_000,
        maxPerMinute: 20,
      },
      { fetchImpl, now: () => 5_000 },
    );
    const readResult = await api.read();
    const merged = mergePublicApiIntoSnapshot(
      snapshot({
        gold: 12,
        totalLevel: 3,
        combatPhase: 'none',
        inventory: { 'Cooked Cod': 40, Cod: 4, 'Coal Ore': 6 },
      }),
      readResult,
    );

    assert.deepEqual(calls, [
      'https://api.example.test/v1/character/heroHash/information',
      'https://api.example.test/v1/character/heroHash/current-action',
      'https://api.example.test/v1/character/heroHash/pets',
    ]);
    assert.equal(merged.gold, 1500);
    assert.equal(merged.tokens, 3);
    assert.equal(merged.totalLevel, 22);
    assert.equal(merged.skillLevels.mining, 8);
    assert.equal(merged.skillLevels.cooking, 1);
    assert.equal(merged.location, 'Bluebell Hollow');
    assert.equal(merged.currentAction?.busy, true);
    assert.equal(merged.currentAction?.skill, 'mining');
    assert.equal(merged.currentAction?.resource, 'Iron Ore');
    assert.equal(merged.currentAction?.label, 'Mining Iron Ore');
    assert.equal(merged.flags.gatherBusy, true);
    assert.equal(merged.flags.inBattle, false);
    assert.equal(merged.combatPhase, 'none');
    assert.equal(merged.inventory['Cooked Cod'], 40);
    assert.equal(merged.inventory.Cod, 4);
    assert.equal(needsCookBeforeHunt(merged.inventory, 100), true);
    assert.equal(merged.flags.sessionValid, true);
    const extensions = merged.extensions?.publicApi as {
      pets?: { name?: string }[];
      equippedPet?: { name?: string; custom_name?: string };
      identity?: { currentStatus?: string; hashedId?: string };
    };
    assert.equal(extensions.pets?.[0]?.name, 'Rock Pup');
    assert.equal(extensions.equippedPet?.custom_name, 'Pebble');
    assert.equal(extensions.identity?.currentStatus, 'idle');
    assert.equal(extensions.identity?.hashedId, 'heroHash');
    assert.equal(JSON.stringify(merged).includes('test-key'), false);
    assert.equal(JSON.stringify(merged.currentAction).includes('image_url'), false);
  });
});
