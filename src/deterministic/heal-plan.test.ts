import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_HEAL_FOOD_RESERVE,
  healTargetForAttempt,
  parseHealFoodReserve,
  parseHealTargetPct,
  planHealQuantity,
} from './heal-plan.js';

describe('planHealQuantity (round 7 heal reserve)', () => {
  it('HitoriIdle case: 75 cod, Max Health wants 68 → heals to 60%, keeps the reserve', () => {
    const plan = planHealQuantity({ maxHealthQty: 68, hpPct: 10, targetPct: 60, bag: 75, reserve: 35 });
    assert.equal(plan.reason, 'ok');
    assert.equal(plan.qty, 38);
    assert.ok(75 - plan.qty >= 35);
  });

  it('caps by reserve when the target needs more than the spare food', () => {
    const plan = planHealQuantity({ maxHealthQty: 68, hpPct: 0, targetPct: 100, bag: 75, reserve: 35 });
    assert.equal(plan.reason, 'capped_by_reserve');
    assert.equal(plan.qty, 40);
  });

  it('pro-rates from current HP to the target', () => {
    const plan = planHealQuantity({ maxHealthQty: 40, hpPct: 20, targetPct: 60, bag: 200, reserve: 35 });
    assert.equal(plan.reason, 'ok');
    assert.equal(plan.qty, 20);
  });

  it('without HP uses the target fraction of Max Health', () => {
    const plan = planHealQuantity({ maxHealthQty: 50, targetPct: 60, bag: 200, reserve: 35 });
    assert.equal(plan.qty, 30);
  });

  it('refuses to feed when the bag is at or below the reserve', () => {
    const plan = planHealQuantity({ maxHealthQty: 20, hpPct: 5, targetPct: 60, bag: 35, reserve: 35 });
    assert.equal(plan.qty, 0);
    assert.equal(plan.reason, 'reserve_low');
  });

  it('feeds at least 1 when the game says HP is too low', () => {
    const plan = planHealQuantity({ maxHealthQty: 10, hpPct: 70, targetPct: 60, bag: 100, reserve: 35 });
    assert.equal(plan.qty, 1);
  });

  it('unknown bag: no reserve cap, still target-limited', () => {
    const plan = planHealQuantity({ maxHealthQty: 68, hpPct: 0, targetPct: 60, reserve: 35 });
    assert.equal(plan.qty, 41);
  });

  it('attempt targets step up to 100', () => {
    assert.equal(healTargetForAttempt(1, 60), 60);
    assert.equal(healTargetForAttempt(2, 60), 80);
    assert.equal(healTargetForAttempt(3, 60), 100);
  });

  it('env parsing', () => {
    assert.equal(parseHealFoodReserve({}), DEFAULT_HEAL_FOOD_RESERVE);
    assert.equal(parseHealFoodReserve({ HEAL_FOOD_RESERVE: '50' }), 50);
    assert.equal(parseHealTargetPct({ HEAL_TARGET_PCT: '500' }), 100);
    assert.equal(parseHealTargetPct({ HEAL_TARGET_PCT: 'x' }), 60);
  });
});
