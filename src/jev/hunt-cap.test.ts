import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { huntFoundCap, isHuntHardStop } from './hunt-cap.js';

describe('huntFoundCap', () => {
  it('returns 1 at combat level 1', () => {
    assert.equal(huntFoundCap(1), 1);
    assert.equal(huntFoundCap(1, 102), 1);
  });

  it('scales up to max 10', () => {
    assert.equal(huntFoundCap(20), 10);
    assert.equal(huntFoundCap(5), 3);
  });
});

describe('isHuntHardStop', () => {
  it('triggers at found >= cap for combat 1', () => {
    assert.equal(isHuntHardStop({ totalEnemiesFound: 1, enemies: [], defeatedCount: 0, pageText: '', combatLevel: 1 }), true);
    assert.equal(isHuntHardStop({ totalEnemiesFound: 0, enemies: [], defeatedCount: 0, pageText: '', combatLevel: 1 }), false);
  });
});
