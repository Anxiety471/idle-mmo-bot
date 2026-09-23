import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { huntFoundCap, isHuntHardStop } from './hunt-cap.js';

describe('huntFoundCap', () => {
  const previous = process.env.HUNT_FOUND_CAP;

  it('defaults to 100 Total Enemies Found regardless of combat level', () => {
    delete process.env.HUNT_FOUND_CAP;
    try {
      assert.equal(huntFoundCap(1), 100);
      assert.equal(huntFoundCap(1, 102), 100);
      assert.equal(huntFoundCap(20), 100);
      assert.equal(huntFoundCap(), 100);
    } finally {
      if (previous === undefined) delete process.env.HUNT_FOUND_CAP;
      else process.env.HUNT_FOUND_CAP = previous;
    }
  });

  it('honors HUNT_FOUND_CAP when set', () => {
    process.env.HUNT_FOUND_CAP = '40';
    try {
      assert.equal(huntFoundCap(1), 40);
    } finally {
      if (previous === undefined) delete process.env.HUNT_FOUND_CAP;
      else process.env.HUNT_FOUND_CAP = previous;
    }
  });
});

describe('isHuntHardStop', () => {
  const previous = process.env.HUNT_FOUND_CAP;

  it('battles once Total Enemies Found reaches the default 100', () => {
    delete process.env.HUNT_FOUND_CAP;
    try {
      assert.equal(isHuntHardStop({ totalEnemiesFound: 121, enemies: [], defeatedCount: 0, pageText: '', combatLevel: 1 }), true);
      assert.equal(isHuntHardStop({ totalEnemiesFound: 100, enemies: [], defeatedCount: 0, pageText: '', combatLevel: 20 }), true);
      assert.equal(isHuntHardStop({ totalEnemiesFound: 99, enemies: [], defeatedCount: 0, pageText: '', combatLevel: 1 }), false);
      assert.equal(isHuntHardStop({ totalEnemiesFound: 0, enemies: [], defeatedCount: 0, pageText: '', combatLevel: 1 }), false);
    } finally {
      if (previous === undefined) delete process.env.HUNT_FOUND_CAP;
      else process.env.HUNT_FOUND_CAP = previous;
    }
  });
});
