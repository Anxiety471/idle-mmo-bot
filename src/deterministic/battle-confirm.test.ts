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
  tileDropConfirmed,
  worstCaseCookedCodAfterFight,
} from './battle-confirm.js';
import { battleGuard, resetBattleGuard } from '../autopilot/battle-guard.js';

describe('tileDropConfirmed', () => {
  const t = (name: string, quantity?: number, index = 0) => ({ name, quantity, index });
  it('confirms a drop or vanish of the fought tile only', () => {
    assert.equal(tileDropConfirmed([t('Goblin', 35), t('Duck', 7)], 'Goblin', 40), true);
    assert.equal(tileDropConfirmed([t('Duck', 7)], 'Goblin', 40), true);
    assert.equal(tileDropConfirmed([t('Goblin', 40), t('Duck', 7)], 'Goblin', 40), false);
  });
  it('never confirms on an empty/failed read or unknown qtyBefore', () => {
    assert.equal(tileDropConfirmed([], 'Goblin', 40), false);
    assert.equal(tileDropConfirmed([t('Duck', 7)], 'Goblin', undefined), false);
  });
  it('handles duplicate names without a false positive', () => {
    // Fought Goblin 7 while another Goblin 40 is listed: nothing changed.
    assert.equal(tileDropConfirmed([t('Goblin', 40), t('Goblin', 7)], 'Goblin', 7), false);
    // Fought Goblin 40, Goblin 7 still listed: the 40 stack is gone.
    assert.equal(tileDropConfirmed([t('Goblin', 7)], 'Goblin', 40), true);
  });
});

describe('battleGuard', () => {
  const snap = (type?: string, expiresAt?: string, inBattle = false) =>
    ({ currentAction: type ? { busy: true, type, expiresAt } : { busy: false }, flags: { inBattle } }) as never;
  it('blocks while the API says BATTLE, then bounds the wait', () => {
    resetBattleGuard();
    const t0 = Date.parse('2026-09-30T00:00:00Z');
    const future = new Date(t0 + 120_000).toISOString();
    assert.equal(battleGuard(snap('BATTLE', future), t0), 'battle');
    assert.equal(battleGuard(snap('BATTLE', future), t0 + 60_000), 'battle');
    // expires_at well in the past: stale, not a live battle.
    assert.equal(battleGuard(snap('BATTLE', future), t0 + 400_000), 'stale');
    // No expiry: bounded by BATTLE_GUARD_MAX_MS (15 min default).
    resetBattleGuard();
    assert.equal(battleGuard(snap('BATTLE'), t0), 'battle');
    assert.equal(battleGuard(snap('BATTLE'), t0 + 16 * 60_000), 'stale');
    assert.equal(battleGuard(snap('COOKING'), t0 + 17 * 60_000), 'none');
    assert.equal(battleGuard(snap('BATTLE'), t0 + 18 * 60_000), 'battle');
    resetBattleGuard();
  });
});

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

describe('pendingExtraWaitMs (round 7)', () => {
  it('defaults to 20s, honours COMBAT_PENDING_EXTRA_MS and caps at 120s', async () => {
    const { pendingExtraWaitMs } = await import('./battle-confirm.js');
    assert.equal(pendingExtraWaitMs({}), 20_000);
    assert.equal(pendingExtraWaitMs({ COMBAT_PENDING_EXTRA_MS: '5000' }), 5_000);
    assert.equal(pendingExtraWaitMs({ COMBAT_PENDING_EXTRA_MS: '999999' }), 120_000);
  });
});
