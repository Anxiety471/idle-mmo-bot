import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyCombatLevelSanity,
  applyInventorySanity,
  baitCountLooksLikePresenceFallback,
  emptySnapshotHealthState,
  inventoryReadLooksCollapsed,
  rawCodZeroConfirmed,
  recordRawCodBagRead,
} from './snapshot-health.js';

describe('snapshot-health inventory sanity', () => {
  it('detects collapsed inventory reads', () => {
    const previous = {
      'Raw Cod': 221,
      'Cooked Cod': 83,
      'Coal Ore': 11000,
      'Cheap Bait': 8,
      'Oak Log': 2900,
      'Yew Log': 1,
    };
    const fresh = { 'Cheap Bait': 1 };
    assert.equal(inventoryReadLooksCollapsed(previous, fresh), true);
  });

  it('keeps previous inventory when collapsed', () => {
    const state = emptySnapshotHealthState();
    state.lastInventory = {
      'Raw Cod': 200,
      'Coal Ore': 50,
      'Cooked Cod': 80,
      'Cheap Bait': 8,
      'Oak Log': 100,
      'Yew Log': 1,
    };
    const result = applyInventorySanity(state, { 'Cheap Bait': 1 });
    assert.equal(result.degraded, true);
    assert.equal(result.inventory['Raw Cod'], 200);
  });
});

describe('snapshot-health raw cod reads', () => {
  it('requires two agreeing zero reads', () => {
    let state = emptySnapshotHealthState();
    state = recordRawCodBagRead(state, 0);
    assert.equal(rawCodZeroConfirmed(state), false);
    state = recordRawCodBagRead(state, 0);
    assert.equal(rawCodZeroConfirmed(state), true);
  });
});

describe('snapshot-health combat level', () => {
  it('reuses last combat level when parse misses', () => {
    const state = { ...emptySnapshotHealthState(), lastCombatLevel: 42 };
    const result = applyCombatLevelSanity(state, undefined);
    assert.equal(result.combatLevel, 42);
    assert.equal(result.degraded, true);
  });
});

describe('baitCountLooksLikePresenceFallback', () => {
  it('flags single bait count while degraded', () => {
    assert.equal(
      baitCountLooksLikePresenceFallback({ 'Cheap Bait': 1 }, true),
      true,
    );
    assert.equal(
      baitCountLooksLikePresenceFallback({ 'Cheap Bait': 2 }, true),
      false,
    );
  });
});
