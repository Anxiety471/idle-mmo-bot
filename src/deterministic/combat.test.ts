import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enemyNameFromDetailText,
  enemyNameFromImageSrc,
  cookedCodCount,
  inventoryCanCookBattleFood,
  inventoryHasBattleFood,
  needsCookBeforeHunt,
  hasHuntProgress,
  huntingMetricsSection,
  isActiveHuntPanelText,
  isIdleBattleText,
  parseHuntMetrics,
  pickBattleEnemy,
} from './combat.js';
import type { EnemyInfo, HuntState } from '../types.js';

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

/** Live HitoriIdle mobile UI — Image A (active Hunting, label-then-number rows). */
const LIVE_ACTIVE_HUNT_PANEL = `Battle
Hunting
+0
Next enemy in 0:18
0.23 EXP/s
Battle
Stats
Total Enemies Found
407
Enemies Remaining
448
Bonus Enemies
0
EXP Per Second
0.23
Loot Found
0
Power Hunt
Stop`;

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

  it('scopes metrics to CURRENT ACTION and ignores ENEMIES NEARBY zone count', () => {
    const section = huntingMetricsSection(ACTIVE_HUNT_PANEL);
    assert.ok(section.includes('Total Enemies Found'));
    assert.ok(!section.includes('ENEMIES NEARBY'));
    const metrics = parseHuntMetrics(ACTIVE_HUNT_PANEL);
    assert.equal(metrics.totalEnemiesFound, 1);
    assert.equal(metrics.enemiesRemaining, 39);
  });

  it('does not treat ENEMIES NEARBY 40 as totalEnemiesFound when hunt labels are absent', () => {
    const text = `Stop
CURRENT ACTION
Hunting
ENEMIES NEARBY
40
Windy`;
    const metrics = parseHuntMetrics(text);
    assert.equal(metrics.totalEnemiesFound, undefined);
  });

  it('parses the live hunt strip at 121 found and treats it as ready to battle', () => {
    const text = `Battle
Total Enemies Found
121
Enemies Remaining
831
Bonus Enemies
?
0
EXP Per Second
0.22
Loot Found
0
Power Hunt
Stop
What is hunting?`;
    const metrics = parseHuntMetrics(text);
    assert.equal(metrics.totalEnemiesFound, 121);
    assert.equal(metrics.enemiesRemaining, 831);
    assert.equal(metrics.bonusEnemies, 0);
    assert.equal(isActiveHuntPanelText(text), true);
  });

  it('parses stacked labels then values, ignoring Enemies Remaining as the found count', () => {
    const text = `Total Enemies Found
Enemies Remaining
Bonus Enemies
EXP Per Second
Loot Found
121
831
0
0.22
0
Power Hunt
Stop`;
    const metrics = parseHuntMetrics(text);
    assert.equal(metrics.totalEnemiesFound, 121);
    assert.equal(metrics.enemiesRemaining, 831);
    assert.equal(metrics.bonusEnemies, 0);
  });

  it('parses live mobile Hunting panel (label row then value row)', () => {
    const metrics = parseHuntMetrics(LIVE_ACTIVE_HUNT_PANEL);
    assert.equal(metrics.totalEnemiesFound, 407);
    assert.equal(metrics.enemiesRemaining, 448);
    assert.equal(metrics.bonusEnemies, 0);
    const section = huntingMetricsSection(LIVE_ACTIVE_HUNT_PANEL);
    assert.ok(section.includes('Hunting'));
    assert.ok(section.includes('Total Enemies Found'));
    assert.ok(!section.includes('Power Hunt'));
  });

  it('parses side-by-side label value on one line', () => {
    const text = `Hunting\nTotal Enemies Found 407\nEnemies Remaining 448`;
    const metrics = parseHuntMetrics(text);
    assert.equal(metrics.totalEnemiesFound, 407);
    assert.equal(metrics.enemiesRemaining, 448);
  });

  it('parses colon-separated hunt metrics in CURRENT ACTION', () => {
    const text = `CURRENT ACTION
Hunting
Total Enemies Found: 2
Enemies Remaining: 18
Bonus Enemies: 0`;
    const metrics = parseHuntMetrics(text);
    assert.equal(metrics.totalEnemiesFound, 2);
    assert.equal(metrics.enemiesRemaining, 18);
    assert.equal(metrics.bonusEnemies, 0);
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

const MIXED_ENEMIES_NEARBY = `Hunt More
ENEMIES NEARBY
3
Goblin
Lv. 3
Rabbit
Lv. 1
Duck
Lv. 2
STANCE
Balanced
Battle`;

describe('pickBattleEnemy', () => {
  it('prefers Rabbit in a mixed ENEMIES NEARBY list', () => {
    const enemies: EnemyInfo[] = [
      { name: 'Goblin', index: 0 },
      { name: 'Rabbit', index: 1 },
      { name: 'Duck', index: 2 },
    ];
    const picked = pickBattleEnemy(enemies);
    assert.equal(picked?.name, 'Rabbit');
    assert.equal(picked?.index, 1);
  });

  it('falls back to first enemy when Rabbit is absent', () => {
    const enemies: EnemyInfo[] = [
      { name: 'Goblin', index: 0 },
      { name: 'Duck', index: 1 },
    ];
    const picked = pickBattleEnemy(enemies);
    assert.equal(picked?.name, 'Goblin');
  });

  it('returns undefined for empty list', () => {
    assert.equal(pickBattleEnemy([]), undefined);
  });
});

describe('mixed enemy list metrics isolation', () => {
  it('does not treat ENEMIES NEARBY pool count as hunt found metric', () => {
    const metrics = parseHuntMetrics(MIXED_ENEMIES_NEARBY);
    assert.equal(metrics.totalEnemiesFound, undefined);
    assert.equal(metrics.enemiesRemaining, undefined);
  });
});

describe('isIdleBattleText', () => {
  it('detects idle Start Hunt screen from live desktop screenshot copy', () => {
    const idle = `Battle
ENEMIES NEARBY
Hunt
Start a hunt to find nearby enemies.
Start Hunt
YOUR CHARACTER`;
    assert.equal(isIdleBattleText(idle), true);
    assert.equal(isIdleBattleText(LIVE_ACTIVE_HUNT_PANEL), false);
  });
});

describe('inventory battle food', () => {
  it('treats any cooked stack as battle food', () => {
    assert.equal(inventoryHasBattleFood({ 'Cooked Cod': 2 }), true);
    assert.equal(inventoryHasBattleFood({ 'Cooked Salmon': 1 }), true);
    assert.equal(inventoryHasBattleFood({ Cod: 10, 'Coal Ore': 10 }), false);
    assert.equal(inventoryHasBattleFood({}), false);
  });

  it('can cook when raw cod and coal are both in inventory', () => {
    assert.equal(inventoryCanCookBattleFood({ Cod: 1, 'Coal Ore': 1 }), true);
    assert.equal(inventoryCanCookBattleFood({ 'Raw Cod': 2, Coal: 3 }), true);
    assert.equal(inventoryCanCookBattleFood({ Cod: 4 }), false);
    assert.equal(inventoryCanCookBattleFood({ 'Cooked Cod': 5 }), false);
  });

  it('cooks before hunt when Cooked Cod is empty or under the target', () => {
    const ingredients = { Cod: 20, 'Coal Ore': 20 };
    assert.equal(cookedCodCount({ ...ingredients, 'Cooked Cod': 0 }), 0);
    assert.equal(needsCookBeforeHunt({ ...ingredients, 'Cooked Cod': 0 }, 100), true);
    assert.equal(needsCookBeforeHunt({ ...ingredients, 'Cooked Cod': 40 }, 100), true);
    assert.equal(needsCookBeforeHunt({ ...ingredients, 'Cooked Cod': 100 }, 100), false);
    assert.equal(needsCookBeforeHunt({ ...ingredients, 'Cooked Cod': 140 }, 100), false);
    assert.equal(needsCookBeforeHunt({ 'Cooked Cod': 0 }, 100), false);
  });
});

describe('enemyNameFromDetailText', () => {
  it('reads the name above Combat EXP in the battle-entity modal', () => {
    const text = `Rabbit
3 Combat EXP
Level 1
20% Chance of Loot
FOOD
Add
STANCE
Balanced (All Stats)
ENEMIES`;
    assert.equal(enemyNameFromDetailText(text), 'Rabbit');
  });

  it('reads an inline name and Combat EXP', () => {
    assert.equal(enemyNameFromDetailText('Goblin 4 Combat EXP'), 'Goblin');
  });
});

describe('enemyNameFromImageSrc', () => {
  it('maps CDN/meta slugs to enemy names for icon tiles', () => {
    assert.equal(enemyNameFromImageSrc('/enemies/rabbit-icon.png'), 'Rabbit');
    assert.equal(enemyNameFromImageSrc('/enemies/duck-icon.png'), 'Duck');
    assert.equal(enemyNameFromImageSrc('/enemies/crown-goblin.png'), 'Crown Goblin');
    assert.equal(enemyNameFromImageSrc('/enemies/goblin.png'), 'Goblin');
    assert.equal(enemyNameFromImageSrc('/enemies/unknown.png'), undefined);
  });
});
