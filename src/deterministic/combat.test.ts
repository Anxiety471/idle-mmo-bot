import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasHuntProgress, parseHuntMetrics } from './combat.js';
import type { HuntState } from '../types.js';

const ACTIVE_HUNT_PANEL = `Stop
CURRENT ACTION
Hunting
Total Enemies Found
1
Enemies Remaining
39
Bonus Enemies
0
ENEMIES NEARBY
40
Windy
Combat`;

const POST_STOP_SELECTION = `Hunt More
ENEMIES NEARBY
40
STANCE
Balanced
Battle`;

describe('parseHuntMetrics', () => {
  it('parses hunt metrics from multiline IdleMMO combat panel', () => {
    const metrics = parseHuntMetrics(ACTIVE_HUNT_PANEL);
    assert.equal(metrics.totalEnemiesFound, 1);
    assert.equal(metrics.enemiesRemaining, 39);
    assert.equal(metrics.bonusEnemies, 0);
  });

  it('parses inline label:value hunt metrics', () => {
    const text = 'Stop\nTotal Enemies Found: 3\nEnemies Remaining: 12\nBonus Enemies: 1';
    const metrics = parseHuntMetrics(text);
    assert.equal(metrics.totalEnemiesFound, 3);
    assert.equal(metrics.enemiesRemaining, 12);
    assert.equal(metrics.bonusEnemies, 1);
  });

  it('returns undefined metrics when hunt labels are absent', () => {
    const metrics = parseHuntMetrics(POST_STOP_SELECTION);
    assert.equal(metrics.totalEnemiesFound, undefined);
    assert.equal(metrics.enemiesRemaining, undefined);
    assert.equal(metrics.bonusEnemies, undefined);
  });

  it('falls back to Enemies Found without Total prefix', () => {
    const metrics = parseHuntMetrics('Stop\nEnemies Found\n2\nEnemies Remaining\n5');
    assert.equal(metrics.totalEnemiesFound, 2);
    assert.equal(metrics.enemiesRemaining, 5);
  });
});

describe('hasHuntProgress', () => {
  it('detects progress from totalEnemiesFound', () => {
    const state: HuntState = { enemies: [], defeatedCount: 0, totalEnemiesFound: 1, pageText: '' };
    assert.equal(hasHuntProgress(state), true);
  });

  it('detects progress from enemy cards', () => {
    const state: HuntState = {
      enemies: [{ name: 'Rabbit', index: 0 }],
      defeatedCount: 0,
      pageText: '',
    };
    assert.equal(hasHuntProgress(state), true);
  });

  it('detects progress from defeated count', () => {
    const state: HuntState = { enemies: [], defeatedCount: 2, pageText: '' };
    assert.equal(hasHuntProgress(state), true);
  });

  it('returns false for empty hunt state (ENEMIES NEARBY label only)', () => {
    const state: HuntState = { enemies: [], defeatedCount: 0, pageText: '' };
    assert.equal(hasHuntProgress(state), false);
    assert.equal(hasHuntProgress(parseHuntMetricsToState(POST_STOP_SELECTION)), false);
  });
});

function parseHuntMetricsToState(text: string): HuntState {
  return { enemies: [], defeatedCount: 0, pageText: text, ...parseHuntMetrics(text) };
}
