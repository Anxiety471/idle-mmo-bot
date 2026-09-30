import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnemyInfo } from '../types.js';

function enemyStackSize(enemy: EnemyInfo): number {
  const qty = enemy.quantity;
  if (qty === 0) return 0;
  return qty !== undefined && qty > 0 ? qty : 1;
}

function readyEnemies(enemies: EnemyInfo[]): EnemyInfo[] {
  return enemies.filter((enemy) => !enemy.restrictive && enemyStackSize(enemy) >= 1);
}

describe('enemy tile quantity handling', () => {
  it('keeps quantity 0 as 0 and skips those tiles', () => {
    const enemies: EnemyInfo[] = [
      { name: 'stack 0', index: 0, quantity: 0 },
      { name: 'Goblin', index: 1, quantity: 17 },
    ];
    assert.equal(enemyStackSize(enemies[0]), 0);
    const ready = readyEnemies(enemies);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].name, 'Goblin');
  });
});
