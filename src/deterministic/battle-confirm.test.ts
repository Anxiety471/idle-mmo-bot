import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  battleFoodPackQuantity,
  enemyTileReducedOrGone,
  isApiBattleActionType,
  isFightAcceptedFromPageText,
  isPreBattleClickFailure,
  parsePackedFoodQuantityFromModalText,
  shouldRefreshCookGateAfterFight,
  worstCaseCookedCodAfterFight,
} from './battle-confirm.js';

describe('battleFoodPackQuantity', () => {
  it('caps packed food per fight', () => {
    assert.equal(battleFoodPackQuantity(72, 25), 25);
    assert.equal(battleFoodPackQuantity(10, 25), 10);
    assert.equal(battleFoodPackQuantity(0, 25), 0);
  });
});

describe('parsePackedFoodQuantityFromModalText', () => {
  it('reads Nx badges in the food row', () => {
    assert.equal(parsePackedFoodQuantityFromModalText('Cooked Cod 25x Add'), 25);
    assert.equal(parsePackedFoodQuantityFromModalText('no food'), 0);
  });
});

describe('isFightAcceptedFromPageText', () => {
  it('accepts Run Away, defeat counters, and API battle type', () => {
    assert.equal(isFightAcceptedFromPageText('Stats\nRun Away\nHealth'), true);
    assert.equal(isFightAcceptedFromPageText('5 Defeated / 35 Remaining'), true);
    assert.equal(
      isFightAcceptedFromPageText('Idle', { apiActionType: 'BATTLE' }),
      true,
    );
    assert.equal(isFightAcceptedFromPageText('ENEMIES NEARBY\nBattle'), false);
  });
});

describe('isApiBattleActionType', () => {
  it('matches battle action types case-insensitively', () => {
    assert.equal(isApiBattleActionType('BATTLE'), true);
    assert.equal(isApiBattleActionType('battle'), true);
    assert.equal(isApiBattleActionType('COOKING'), false);
  });
});

describe('enemyTileReducedOrGone', () => {
  it('detects stack drops and removed tiles', () => {
    assert.equal(enemyTileReducedOrGone(40, 35, true), true);
    assert.equal(enemyTileReducedOrGone(40, undefined, false), true);
    assert.equal(enemyTileReducedOrGone(40, 40, true), false);
  });
});

describe('worstCaseCookedCodAfterFight', () => {
  it('subtracts heal spend and packed food from the snapshot bag', () => {
    assert.equal(worstCaseCookedCodAfterFight(72, 0, 72), 0);
    assert.equal(worstCaseCookedCodAfterFight(72, 5, 20), 47);
  });
});

describe('shouldRefreshCookGateAfterFight', () => {
  it('requires a fresh scrape when worst case is below the hunt cook floor', () => {
    assert.equal(shouldRefreshCookGateAfterFight(0, 30), true);
    assert.equal(shouldRefreshCookGateAfterFight(30, 30), false);
  });
});

describe('isPreBattleClickFailure', () => {
  it('only allows walking tiles after disabled or missing pre-click states', () => {
    assert.equal(isPreBattleClickFailure('disabled'), true);
    assert.equal(isPreBattleClickFailure('missing'), true);
    assert.equal(isPreBattleClickFailure('no_fight'), false);
  });
});
