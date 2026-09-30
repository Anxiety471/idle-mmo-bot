import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyCombatLevelSanity,
  applyInventorySanity,
  baitCountLooksLikePresenceFallback,
  emptySnapshotHealthState,
  inventoryReadLooksCollapsed,
  MAX_CONSECUTIVE_DEGRADED,
  rawCodZeroConfirmed,
  recordRawCodBagRead,
  type SnapshotHealthState,
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

describe('snapshot-health degraded is bounded', () => {
  const full = {
    'Raw Cod': 200,
    'Coal Ore': 50,
    'Cooked Cod': 80,
    'Cheap Bait': 8,
    'Oak Log': 100,
    'Yew Log': 1,
  };

  it('accepts a persistent collapsed read after MAX_CONSECUTIVE_DEGRADED cycles', () => {
    let state: SnapshotHealthState = { ...emptySnapshotHealthState(), lastInventory: { ...full } };
    const flags: boolean[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_DEGRADED + 2; i++) {
      const r = applyInventorySanity(state, { 'Cheap Bait': 1 });
      flags.push(r.degraded);
      state = r.state;
    }
    assert.deepEqual(flags.slice(0, MAX_CONSECUTIVE_DEGRADED), Array(MAX_CONSECUTIVE_DEGRADED).fill(true));
    assert.equal(flags[MAX_CONSECUTIVE_DEGRADED], false);
    assert.equal(flags[MAX_CONSECUTIVE_DEGRADED + 1], false);
    assert.deepEqual(state.lastInventory, { 'Cheap Bait': 1 });
  });

  it('good read resets the inventory streak', () => {
    let state: SnapshotHealthState = { ...emptySnapshotHealthState(), lastInventory: { ...full } };
    state = applyInventorySanity(state, { 'Cheap Bait': 1 }).state;
    state = applyInventorySanity(state, full).state;
    assert.equal(state.inventoryDegradedStreak, 0);
    assert.equal(applyInventorySanity(state, { 'Cheap Bait': 1 }).degraded, true);
  });

  it('missing combat level stops degrading after MAX_CONSECUTIVE_DEGRADED cycles', () => {
    let state = emptySnapshotHealthState();
    const flags: boolean[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_DEGRADED + 2; i++) {
      const r = applyCombatLevelSanity(state, undefined);
      flags.push(r.degraded);
      state = r.state;
    }
    assert.equal(flags[MAX_CONSECUTIVE_DEGRADED], false);
    assert.equal(flags[MAX_CONSECUTIVE_DEGRADED + 1], false);
    const good = applyCombatLevelSanity(state, 7);
    assert.equal(good.degraded, false);
    assert.equal(good.state.combatMissStreak, 0);
  });
});
