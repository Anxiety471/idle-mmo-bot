import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import {
  enemyNameFromDetailText,
  enemyNameFromImageSrc,
  cookedCodCount,
  inventoryAfterCookedCodSpend,
  inventoryCanCookBattleFood,
  inventoryHasBattleFood,
  needsCookBeforeHunt,
  battleTargetsInOrder,
  describeBattleControlDisabled,
  findFoodAddButton,
  healFoodRank,
  hasHuntProgress,
  huntingMetricsSection,
  isActiveHuntPanelText,
  isIdleBattleText,
  isInActiveBattleFromSignals,
  parseHuntMetrics,
  parseHealthBarStyle,
  parseHealthPercentTextContent,
  parsePlayerHpFromCurrentMax,
  parsePlayerHpPercent,
  readBattleState,
  readPageTextBounded,
  pickBattleEnemy,
  startAnywayStrategyForAttempt,
  effectiveCookedCodStock,
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
      { name: 'Goblin', index: 0, quantity: 27 },
      { name: 'Rabbit', index: 1, quantity: 5 },
      { name: 'Duck', index: 2, quantity: 2 },
    ];
    const picked = pickBattleEnemy(enemies);
    assert.equal(picked?.name, 'Rabbit');
    assert.equal(picked?.index, 1);
  });

  it('chooses the largest stack when the hunt target is absent', () => {
    const enemies: EnemyInfo[] = [
      { name: 'Duck', index: 0, quantity: 2 },
      { name: 'stack 27', index: 1, quantity: 27 },
      { name: 'stack 126', index: 2, quantity: 126 },
    ];
    const picked = pickBattleEnemy(enemies);
    assert.equal(picked?.name, 'stack 126');
    assert.equal(picked?.index, 2);
  });

  it('skips restrictive tiles and still picks the largest ready stack', () => {
    const enemies: EnemyInfo[] = [
      { name: 'Goblin King', index: 0, quantity: 120, restrictive: true },
      { name: 'Goblin', index: 1, quantity: 40 },
    ];
    const picked = pickBattleEnemy(enemies);
    assert.equal(picked?.name, 'Goblin');
  });

  it('returns undefined for empty list', () => {
    assert.equal(pickBattleEnemy([]), undefined);
  });
});

describe('battleTargetsInOrder', () => {
  it('puts Rabbit first and then walks stacks by descending quantity', () => {
    const order = battleTargetsInOrder([
      { name: 'Duck', index: 0, quantity: 2 },
      { name: 'Goblin', index: 1, quantity: 40 },
      { name: 'Rabbit', index: 2, quantity: 5 },
    ]);
    assert.deepEqual(
      order.map((enemy) => enemy.name),
      ['Rabbit', 'Goblin', 'Duck'],
    );
  });
});

describe('describeBattleControlDisabled', () => {
  it('reports restrictive or processing from the live Alpine bind', () => {
    const hint = describeBattleControlDisabled(
      'disabled',
      'selected_battle_entity?.status?.is_restrictive || is_processing',
    );
    assert.match(hint, /disabled=disabled/);
    assert.match(hint, /is_restrictive/);
    assert.match(hint, /is_processing/);
    assert.match(hint, /bind looks restrictive or processing/);
  });

  it('reports processing when that is the only bind clause', () => {
    const hint = describeBattleControlDisabled('', 'is_processing');
    assert.match(hint, /disabled=present/);
    assert.match(hint, /bind looks processing/);
    assert.equal(/restrictive/.test(hint), false);
  });

  it('reports restrictive when that is the only bind clause', () => {
    const hint = describeBattleControlDisabled('disabled', 'is_restrictive');
    assert.match(hint, /bind looks restrictive/);
    assert.equal(/processing/.test(hint), false);
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

describe('heal food choice', () => {
  it('prefers tradable Cooked Cod over an Untradable stack', () => {
    const tradable = healFoodRank('105 Cooked Cod +10 Health');
    const untradable = healFoodRank('12 Cooked Cod (Untradable) +10 Health');
    assert.equal(tradable, 0);
    assert.ok(untradable !== null && tradable !== null && untradable > tradable);
    assert.equal(healFoodRank('Max Health'), null);
    assert.equal(healFoodRank('Use'), null);
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

  it('treats a heal spend as crossing the cook gate without mutating the bag', () => {
    const bag = { 'Cooked Cod': 100, 'Cooked Cod (Untradable)': 5, Cod: 20, 'Coal Ore': 20 };
    assert.equal(needsCookBeforeHunt(bag, 100), false);
    const after = inventoryAfterCookedCodSpend(bag, 10);
    assert.ok(after);
    assert.equal(after['Cooked Cod'], 90);
    assert.equal(after['Cooked Cod (Untradable)'], 5);
    assert.equal(bag['Cooked Cod'], 100);
    assert.equal(needsCookBeforeHunt(after, 100), true);
    assert.equal(cookedCodCount(after), 95);
    assert.equal(inventoryAfterCookedCodSpend(bag, 0), bag);
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

  it('maps ULID CDN skins without meta slug', () => {
    assert.equal(
      enemyNameFromImageSrc(
        '/uploaded/skins/01M3HY9HCSE5035HG4VW2M1ZB3.png',
      ),
      'Goblin',
    );
    assert.equal(
      enemyNameFromImageSrc(
        '/uploaded/skins/01M3HXYRPGSWA31QGRN3E7EK1Z.png',
      ),
      'Goblin King',
    );
  });
});

describe('parsePlayerHpPercent', () => {
  it('parses legacy "% HP" and "HP: N%" patterns', () => {
    assert.equal(parsePlayerHpPercent('Run Away\nBattle\n42% HP\nSkills'), 42);
    assert.equal(parsePlayerHpPercent('HP: 18%\nRun Away'), 18);
    assert.equal(parsePlayerHpPercent('HP 99%'), 99);
  });

  it('parses live Health label with bare percent on the same line', () => {
    assert.equal(parsePlayerHpPercent('Health 76%\nRun Away\nBattle'), 76);
    assert.equal(parsePlayerHpPercent('Health\n76%\nStats'), 76);
  });

  it('prefers Health-scoped percent over unrelated sidebar percentages', () => {
    const text = `Battle
Health
23%
Skill A 88%
Skill B 44%
Run Away`;
    assert.equal(parsePlayerHpPercent(text), 23);
  });

  it('returns undefined when Health is collapsed or HP digits are absent', () => {
    assert.equal(parsePlayerHpPercent('Health\nRun Away\nBattle'), undefined);
    assert.equal(parsePlayerHpPercent('Run Away\nBattle\nStats'), undefined);
  });
});

describe('parseHealthBarStyle', () => {
  it('reads width percent from inline bar style', () => {
    assert.equal(parseHealthBarStyle('width: 100%'), 100);
    assert.equal(parseHealthBarStyle('width: 37.5%'), 37.5);
    assert.equal(parseHealthBarStyle('width:undefined%'), undefined);
  });
});

describe('parseHealthPercentTextContent', () => {
  it('parses numeric x-text percent nodes', () => {
    assert.equal(parseHealthPercentTextContent('100'), 100);
    assert.equal(parseHealthPercentTextContent('42'), 42);
    assert.equal(parseHealthPercentTextContent('n/a'), undefined);
  });
});

describe('parsePlayerHpFromCurrentMax', () => {
  it('derives percent from current and max HP text', () => {
    assert.equal(parsePlayerHpFromCurrentMax('595', '595'), 100);
    assert.equal(parsePlayerHpFromCurrentMax('119', '595'), 20);
  });
});

describe('startAnywayStrategyForAttempt', () => {
  it('escalates click strategy across retries', () => {
    assert.equal(startAnywayStrategyForAttempt(0), 'normal');
    assert.equal(startAnywayStrategyForAttempt(1), 'normal');
    assert.equal(startAnywayStrategyForAttempt(2), 'force');
    assert.equal(startAnywayStrategyForAttempt(3), 'dispatch');
  });
});

describe('needsCookBeforeHunt hunt floor', () => {
  it('uses huntCookFloor while hunt batch is active', () => {
    const inv = { 'Cooked Cod': 80, 'Raw Cod': 5, 'Coal Ore': 5 };
    assert.equal(needsCookBeforeHunt(inv, 100), true);
    assert.equal(
      needsCookBeforeHunt(inv, 100, { huntBatchActive: true, huntCookFloor: 30 }),
      false,
    );
    assert.equal(
      needsCookBeforeHunt({ 'Cooked Cod': 25 }, 100, {
        huntBatchActive: true,
        huntCookFloor: 30,
      }),
      true,
    );
  });

  it('counts packed battle food toward the hunt floor', () => {
    assert.equal(
      effectiveCookedCodStock({ 'Cooked Cod': 20 }, 15),
      35,
    );
    assert.equal(
      needsCookBeforeHunt({ 'Cooked Cod': 20 }, 100, {
        huntBatchActive: true,
        huntCookFloor: 30,
        packedBattleFood: 15,
      }),
      false,
    );
  });
});

describe('readBattleState', () => {
  it('is not in battle when sidebar has Battle and character panel has Health but Run Away is absent', async () => {
    assert.equal(isInActiveBattleFromSignals(false, false), false);

    const html = `<body>
      <nav><button>Battle</button></nav>
      <aside><div>Health</div><div>76%</div></aside>
      <main><button>Start Hunt</button><div>ENEMIES NEARBY</div></main>
    </body>`;

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html);

    const state = await readBattleState(page);
    assert.equal(state.inBattle, false);
    await browser.close();
  });
});

describe('findFoodAddButton', () => {
  it('matches FOOD Add against live Food label and food-for-battle handler', async () => {
    const html = `<div x-data="show-battle-entity">
      <span class="uppercase">Food</span>
      <button type="button" x-on:click="openFoodForBattle()">Add</button>
    </div>`;

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html);
    const add = await findFoodAddButton(page);
    assert.ok(add);
    assert.equal(await add!.innerText(), 'Add');
    await browser.close();
  });
});

describe('readPageTextBounded', () => {
  it('returns empty string when body innerText exceeds the timeout', async () => {
    const page = {
      locator: () => ({
        innerText: ({ timeout }: { timeout: number }) =>
          new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`Timeout ${timeout}ms exceeded`)), timeout);
          }),
      }),
    } as unknown as Page;

    const start = Date.now();
    const text = await readPageTextBounded(page, 40);
    const elapsed = Date.now() - start;

    assert.equal(text, '');
    assert.ok(elapsed < 250);
  });

  it('returns trimmed body text when innerText resolves in time', async () => {
    const page = {
      locator: () => ({
        innerText: async () => '  Run Away\nHealth\n55%\n',
      }),
    } as unknown as Page;

    const text = await readPageTextBounded(page, 500);
    assert.equal(text, 'Run Away\nHealth\n55%');
  });
});
