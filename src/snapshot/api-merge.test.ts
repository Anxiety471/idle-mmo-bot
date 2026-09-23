import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { needsCookBeforeHunt } from '../deterministic/combat.js';
import type { GameSnapshot } from '../types.js';
import {
  applyPublicApiToSnapshot,
  mergeInventoryQuantities,
  mergeSnapshotWithApi,
  resetApiMergeStateForTests,
} from './api-merge.js';

function snapshot(inventory: Record<string, number>, extras?: Partial<GameSnapshot>): GameSnapshot {
  return {
    location: 'unknown',
    pagePath: '/inventory',
    skillLevels: { mining: 1 },
    inventory,
    acceptedQuests: [],
    pendingQuests: [],
    combatPhase: 'none',
    flags: {
      hasBait: (inventory['Cheap Bait'] ?? 0) > 0,
      bankNearby: false,
      gatherBusy: false,
      inBattle: false,
      sessionValid: true,
    },
    ...extras,
  };
}

describe('mergeInventoryQuantities', () => {
  it('lets API quantities win for overlapping food, bait, and ore keys', () => {
    const merged = mergeInventoryQuantities(
      {
        'Cooked Cod': 2,
        'Oak Log': 10,
        Coal: 3,
        Cod: 4,
        'Cheap Bait': 9,
      },
      {
        'Cooked Cod': 40,
        Coal: 15,
        'Raw Cod': 12,
        'Cheap Bait': 0,
      },
    );
    assert.equal(merged['Cooked Cod'], 40);
    assert.equal(merged['Oak Log'], 10);
    assert.equal(merged['Coal Ore'], 15);
    assert.equal(merged.Coal, undefined);
    assert.equal(merged['Raw Cod'], 12);
    assert.equal(merged.Cod, undefined);
    assert.equal(merged['Cheap Bait'], 0);
  });

  it('keeps the scrape map when the API inventory is absent', () => {
    const scrape = { 'Cooked Cod': 2, 'Oak Log': 10 };
    const base = snapshot(scrape);
    const merged = mergeSnapshotWithApi(base, { inventory: null, skillLevels: {} });
    assert.deepEqual(merged.inventory, scrape);
    assert.equal(merged.flags.hasBait, false);
  });
});

describe('mergeSnapshotWithApi', () => {
  it('overlays skills, gold, and a busy action without dropping scrape-only items', () => {
    const merged = mergeSnapshotWithApi(snapshot({ 'Oak Log': 5, 'Cooked Cod': 1 }), {
      inventory: { 'Cooked Cod': 80, 'Raw Cod': 20, 'Coal Ore': 20 },
      skillLevels: { cooking: 9 },
      gold: 1200,
      location: 'Bluebell Hollow',
      currentAction: { busy: true, skill: 'cooking', resource: 'Cooked Cod', label: 'Cooking' },
    });
    assert.equal(merged.inventory['Cooked Cod'], 80);
    assert.equal(merged.inventory['Oak Log'], 5);
    assert.equal(merged.skillLevels.cooking, 9);
    assert.equal(merged.skillLevels.mining, 1);
    assert.equal(merged.gold, 1200);
    assert.equal(merged.location, 'Bluebell Hollow');
    assert.equal(merged.currentAction?.skill, 'cooking');
    assert.equal(merged.flags.gatherBusy, true);
    assert.equal(merged.flags.hasBait, false);
  });

  it('uses API cooked-cod counts with the existing cook-before-hunt rule', () => {
    const undercounted = mergeSnapshotWithApi(
      snapshot({ 'Cooked Cod': 100, Cod: 12, 'Coal Ore': 40 }),
      { inventory: { 'Cooked Cod': 2, 'Raw Cod': 12, 'Coal Ore': 40 }, skillLevels: {} },
    );
    assert.equal(needsCookBeforeHunt(undercounted.inventory, 100), true);

    const corrected = mergeSnapshotWithApi(
      snapshot({ 'Cooked Cod': 0, Cod: 12, 'Coal Ore': 40 }),
      { inventory: { 'Cooked Cod': 100, 'Raw Cod': 12, 'Coal Ore': 40 }, skillLevels: {} },
    );
    assert.equal(needsCookBeforeHunt(corrected.inventory, 100), false);
  });
});

describe('applyPublicApiToSnapshot', () => {
  it('keeps the scrape when the API client is disabled', async () => {
    const base = snapshot({ 'Cooked Cod': 2 });
    const merged = await applyPublicApiToSnapshot(base, { client: null });
    assert.equal(merged.inventory['Cooked Cod'], 2);
  });

  it('prefers API stacks when the client returns inventory', async () => {
    const merged = await applyPublicApiToSnapshot(snapshot({ 'Cooked Cod': 1, 'Oak Log': 4 }), {
      client: {
        async readSnapshot() {
          return {
            inventory: { 'Cooked Cod': 55 },
            skillLevels: {},
          };
        },
      },
    });
    assert.equal(merged.inventory['Cooked Cod'], 55);
    assert.equal(merged.inventory['Oak Log'], 4);
  });

  it('keeps the scrape when the API character does not match CHARACTER_NAME', async () => {
    const base = snapshot({ 'Cooked Cod': 2 });
    const merged = await applyPublicApiToSnapshot(base, {
      characterName: 'IdleBocchi',
      client: {
        async readSnapshot() {
          return {
            characterName: 'MinerAlt',
            inventory: { 'Cooked Cod': 99 },
            skillLevels: {},
            skipped: 'name_mismatch',
          };
        },
      },
    });
    assert.equal(merged.inventory['Cooked Cod'], 2);
  });

  it('keeps the scrape when the client throws', async () => {
    resetApiMergeStateForTests();
    const base = snapshot({ 'Cooked Cod': 2 });
    const merged = await applyPublicApiToSnapshot(base, {
      client: {
        async readSnapshot() {
          throw new Error('network down');
        },
      },
    });
    assert.equal(merged.inventory['Cooked Cod'], 2);
  });
});
