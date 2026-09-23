import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
