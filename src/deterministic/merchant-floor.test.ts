import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  baitPurchaseAllowedByGold,
  baitPurchaseQuantity,
  DEFAULT_BAIT_GOLD_FLOOR,
  parseBaitGoldFloor,
} from './merchant.js';

describe('bait gold floor (round 7)', () => {
  it('defaults to 2000 and reads BAIT_GOLD_FLOOR', () => {
    assert.equal(parseBaitGoldFloor({}), DEFAULT_BAIT_GOLD_FLOOR);
    assert.equal(parseBaitGoldFloor({ BAIT_GOLD_FLOOR: '3500' }), 3500);
    assert.equal(parseBaitGoldFloor({ BAIT_GOLD_FLOOR: 'nope' }), DEFAULT_BAIT_GOLD_FLOOR);
  });

  it('blocks below the floor and when gold is unknown', () => {
    assert.equal(baitPurchaseAllowedByGold(1999, 2000), false);
    assert.equal(baitPurchaseAllowedByGold(undefined, 2000), false);
    assert.equal(baitPurchaseAllowedByGold(2000, 2000), true);
  });

  it('caps quantity so gold stays at/above the floor', () => {
    assert.equal(baitPurchaseQuantity(4492, 50, 2000), 50);
    assert.equal(baitPurchaseQuantity(2040, 50, 2000), 20);
    assert.equal(baitPurchaseQuantity(1500, 50, 2000), 0);
  });

  it('floor 0 allows unknown gold (manual gather CLI)', () => {
    assert.equal(baitPurchaseAllowedByGold(undefined, 0), true);
    assert.equal(baitPurchaseQuantity(undefined, 1, 0), 1);
  });
});
