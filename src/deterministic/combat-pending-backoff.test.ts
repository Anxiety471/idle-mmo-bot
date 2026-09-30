import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  deprioritizeBackedOffTargets,
  noteBattlePendingFor,
  PENDING_BATTLE_BACKOFF_ROUNDS,
  resetPendingBattleBackoffForTest,
  tickPendingBattleBackoff,
} from './combat.js';

describe('pending-verify enemy backoff', () => {
  beforeEach(() => resetPendingBattleBackoffForTest());

  it('moves a pending enemy to the back for N rounds, then restores order', () => {
    const ordered = [
      { name: 'Goblin King', index: 3, quantity: 69 },
      { name: 'Duck', index: 1, quantity: 62 },
      { name: 'Goblin', index: 2, quantity: 55 },
    ];
    noteBattlePendingFor('Goblin King');
    for (let r = 0; r < PENDING_BATTLE_BACKOFF_ROUNDS; r++) {
      const backedOff = tickPendingBattleBackoff();
      assert.deepEqual(
        deprioritizeBackedOffTargets(ordered, backedOff).map((e) => e.name),
        ['Duck', 'Goblin', 'Goblin King'],
      );
    }
    const after = tickPendingBattleBackoff();
    assert.equal(after.size, 0);
    assert.deepEqual(deprioritizeBackedOffTargets(ordered, after).map((e) => e.name), [
      'Goblin King',
      'Duck',
      'Goblin',
    ]);
  });

  it('never drops the only target', () => {
    noteBattlePendingFor('Goblin King');
    const only = [{ name: 'Goblin King', index: 0, quantity: 5 }];
    assert.equal(deprioritizeBackedOffTargets(only, tickPendingBattleBackoff()).length, 1);
  });
});

import type { Page } from 'playwright';
import { isQueuedBattleIndicatorVisible } from './combat.js';

function textPage(visibleTexts: string[]): Page {
  return {
    getByText: (re: RegExp) => {
      const hits = visibleTexts.filter((t) => re.test(t)).length;
      const loc = { filter: () => loc, first: () => loc, count: async () => hits };
      return loc;
    },
  } as unknown as Page;
}

describe('isQueuedBattleIndicatorVisible', () => {
  it('detects the sidebar battle widget and the queued-battle modal copy', async () => {
    assert.equal(await isQueuedBattleIndicatorVisible(textPage(['Next enemy in 0:03'])), true);
    assert.equal(
      await isQueuedBattleIndicatorVisible(
        textPage(['Food cannot be added to queued battles. You can only add food at the start of a battle.']),
      ),
      true,
    );
    assert.equal(await isQueuedBattleIndicatorVisible(textPage(['Hunt More', 'ENEMIES NEARBY'])), false);
  });
});
