import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeQuestTitleKey } from './read-snapshot.js';

describe('normalizeQuestTitleKey', () => {
  it('normalizes apostrophe and case variants', () => {
    assert.equal(
      normalizeQuestTitleKey("A Duck's Whisper"),
      normalizeQuestTitleKey('A Ducks Whisper'),
    );
    assert.equal(
      normalizeQuestTitleKey('A Rabbits Fortune'),
      normalizeQuestTitleKey("A Rabbit's Fortune"),
    );
  });
});

import { readFileSync } from 'node:fs';
import { parseQuestListLines } from './read-snapshot.js';

const PENDING_LIST = `QUEST MASTER LUCIAN

Pending Nearby 4
Accepted
Completed 2
You are viewing quests in Bluebell Hollow. Travel to other places to find more quests!
Scavengers of the Field

Goblin Scraps

15 / 15
 750
Fuel for the Forge

Coal Ore

100 / 100

Tin Ore

0 / 100
 750
A Ducks Whisper

Ducks Mouth

25 / 25
 1,000
A Rabbits Fortune

Lucky Rabbit Foot

40 / 40
 1,500
Statistics
Pending Quests
46`;

describe('parseQuestListLines', () => {
  it('parses single-line titles and multi-objective quests (pending)', () => {
    const quests = parseQuestListLines(PENDING_LIST, 'pending');
    assert.deepEqual(
      quests.map((q) => [q.title, q.progress]),
      [
        ['Scavengers of the Field', '15 / 15'],
        ['Fuel for the Forge', '0 / 100'],
        ['A Ducks Whisper', '25 / 25'],
        ['A Rabbits Fortune', '40 / 40'],
      ],
    );
    assert.ok(quests.every((q) => !q.canTurnIn));
  });

  it('accepted multi-objective quest is not turn-in ready until every objective is met', () => {
    const accepted = PENDING_LIST.replace('Pending Nearby 4', 'Pending Nearby 3');
    const quests = parseQuestListLines(accepted, 'accepted');
    const forge = quests.find((q) => q.title === 'Fuel for the Forge');
    assert.equal(forge?.canTurnIn, false);
    assert.equal(quests.find((q) => q.title === 'A Rabbits Fortune')?.canTurnIn, true);
    assert.equal(quests.some((q) => q.title === 'Tin Ore'), false);
  });

  it('parses the live probe dump when present', () => {
    let text = '';
    try {
      text = readFileSync('/workspace/pv-probe/r4/quests-pending.txt', 'utf8');
    } catch {
      return;
    }
    const titles = parseQuestListLines(text, 'pending').map((q) => q.title);
    assert.deepEqual(titles, [
      'Scavengers of the Field',
      'Fuel for the Forge',
      'A Ducks Whisper',
      'A Rabbits Fortune',
    ]);
  });
});

import { looksLikeQuestTitle, parseQuestCards } from './read-snapshot.js';

describe('quest list timers / cooldown cards', () => {
  it('never treats countdown strings as titles', () => {
    for (const t of ['23:59:26', '21:00:18', '0:59', '3h 22m', '12m 5s', '750', '1,500']) {
      assert.equal(looksLikeQuestTitle(t), false, t);
    }
    assert.equal(looksLikeQuestTitle('Scavengers of the Field'), true);
  });

  it('drops a pending card on cooldown (title, timer, objective) and keeps the rest', () => {
    const text = `Pending Nearby 2
Accepted
Completed 3
You are viewing quests in Bluebell Hollow. Travel to other places to find more quests!
Scavengers of the Field

23:57:18

Goblin Scraps

15 / 15
 750
A Ducks Whisper

Ducks Mouth

25 / 25
 1,000
Statistics`;
    const quests = parseQuestListLines(text, 'pending');
    assert.deepEqual(quests.map((q) => q.title), ['A Ducks Whisper']);
  });

  it('only-cooldown pending tab yields no quests (no timer title)', () => {
    const text = `You are viewing quests in Bluebell Hollow.
Scavengers of the Field
23:57:18
Goblin Scraps
15 / 15
 750
Statistics`;
    assert.deepEqual(parseQuestListLines(text, 'pending'), []);
    // No regex fallback may resurrect the objective ("Goblin Scraps") as a quest.
    assert.deepEqual(parseQuestCards(text, 'pending'), []);
  });
});
