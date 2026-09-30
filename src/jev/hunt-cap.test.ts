import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enemyBacklogTotal,
  huntFoundCap,
  isHuntHardStop,
  shouldSkipHuntMore,
} from './hunt-cap.js';

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

describe('enemy backlog cap', () => {
  it('sums tile quantities for backlog totals', () => {
    assert.equal(
      enemyBacklogTotal([
        { name: 'Duck', index: 0, quantity: 2 },
        { name: 'Goblin', index: 1, quantity: 27 },
        { name: 'Goblin King', index: 2, quantity: 126 },
      ]),
      155,
    );
  });

  it('skips Hunt More when backlog meets the cap even if found counter is higher', () => {
    delete process.env.HUNT_FOUND_CAP;
    const enemies = [
      { name: 'Duck', index: 0, quantity: 2 },
      { name: 'Goblin King', index: 1, quantity: 120 },
    ];
    assert.equal(shouldSkipHuntMore(enemies), true);
    assert.equal(shouldSkipHuntMore([{ name: 'Rabbit', index: 0, quantity: 40 }]), false);
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

import { huntPollBoundReached } from './hunt-cap.js';

describe('huntPollBoundReached', () => {
  const base = { startedAt: 0, lastChangeAt: 0, maxMs: 60 * 60_000, staleMs: 15 * 60_000 };
  it('stops after the wall-clock bound', () => {
    assert.equal(huntPollBoundReached({ ...base, found: 50, lastChangeAt: 59 * 60_000, now: 61 * 60_000 }), 'wall_clock');
  });
  it('stops when Found is stuck (nonzero) past the stale bound', () => {
    assert.equal(huntPollBoundReached({ ...base, found: 71, now: 16 * 60_000 }), 'stale');
  });
  it('keeps polling while Found moves inside the bounds', () => {
    assert.equal(huntPollBoundReached({ ...base, found: 71, lastChangeAt: 10 * 60_000, now: 16 * 60_000 }), null);
    assert.equal(huntPollBoundReached({ ...base, found: 0, now: 16 * 60_000 }), null);
  });
});
