import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SnapshotQuest } from '../types.js';
import {
  GOBLIN_QUEST,
  HEARTH_QUEST,
  getQuestDialogueLine,
  hasEasyCompletePendingQuest,
  isQuestProgressMet,
  parseQuestProgressFraction,
  rankPendingQuestForAccept,
} from './quest-accept.js';

function pendingQuest(title: string, progress?: string): SnapshotQuest {
  return {
    title,
    progress,
    canTurnIn: false,
    tab: 'pending',
  };
}

describe('parseQuestProgressFraction', () => {
  it('parses bare fractions', () => {
    assert.deepEqual(parseQuestProgressFraction('150 / 150'), { current: 150, total: 150 });
  });

  it('parses item-prefixed progress', () => {
    assert.deepEqual(parseQuestProgressFraction('Oak Log 42 / 150'), {
      current: 42,
      total: 150,
    });
  });

  it('returns null for missing progress', () => {
    assert.equal(parseQuestProgressFraction(undefined), null);
  });
});

describe('isQuestProgressMet', () => {
  it('is true when current meets total', () => {
    assert.equal(isQuestProgressMet('150/150'), true);
    assert.equal(isQuestProgressMet('Oak Log 200 / 150'), true);
  });

  it('is false when below quota', () => {
    assert.equal(isQuestProgressMet('149 / 150'), false);
  });
});

describe('rankPendingQuestForAccept', () => {
  it('prefers Hearth 150/150 over Goblin Menace', () => {
    const quests = [
      pendingQuest(GOBLIN_QUEST),
      pendingQuest(HEARTH_QUEST, '150 / 150'),
    ];
    const pick = rankPendingQuestForAccept(quests);
    assert.equal(pick?.title, HEARTH_QUEST);
  });

  it('prefers any progress-met quest over incomplete quests', () => {
    const quests = [
      pendingQuest(GOBLIN_QUEST, '1 / 10'),
      pendingQuest(HEARTH_QUEST, '150 / 150'),
    ];
    assert.equal(rankPendingQuestForAccept(quests)?.title, HEARTH_QUEST);
  });

  it('prefers Hearth over Goblin when neither has met progress', () => {
    const quests = [pendingQuest(GOBLIN_QUEST), pendingQuest(HEARTH_QUEST, '10 / 150')];
    assert.equal(rankPendingQuestForAccept(quests)?.title, HEARTH_QUEST);
  });
});

describe('hasEasyCompletePendingQuest', () => {
  it('detects easy-complete pending quests', () => {
    assert.equal(
      hasEasyCompletePendingQuest([pendingQuest(HEARTH_QUEST, '150/150')]),
      true,
    );
    assert.equal(
      hasEasyCompletePendingQuest([pendingQuest(HEARTH_QUEST, '10 / 150')]),
      false,
    );
  });
});

describe('getQuestDialogueLine', () => {
  it('returns Hearth accept dialogue', () => {
    assert.equal(getQuestDialogueLine(HEARTH_QUEST), "Right. I'll fetch the logs.");
  });
});
