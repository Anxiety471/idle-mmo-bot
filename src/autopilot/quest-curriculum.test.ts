import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GameSnapshot } from '../types.js';
import {
  evaluateQuestCurriculum,
  parseQuestProgress,
  rankQuestTitlesForPriority,
} from './quest-curriculum.js';

function minimalSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    location: 'Melriel',
    pagePath: '/quests',
    skillLevels: { woodcutting: 5 },
    inventory: {},
    acceptedQuests: [],
    pendingQuests: [],
    combatPhase: 'none',
    flags: {
      hasBait: true,
      bankNearby: false,
      gatherBusy: false,
      inBattle: false,
      sessionValid: true,
    },
    currentAction: { busy: false },
    ...overrides,
  };
}

describe('parseQuestProgress', () => {
  it('parses current/target from progress text', () => {
    assert.deepEqual(parseQuestProgress('42 / 150'), { current: 42, target: 150 });
  });
});

describe('evaluateQuestCurriculum', () => {
  it('scores pending Wood for the Hearth as easy gather with talk_accept preferred', () => {
    const curriculum = evaluateQuestCurriculum(
      minimalSnapshot({
        pendingQuests: [{ title: 'Wood for the Hearth', canTurnIn: false, tab: 'pending' }],
      }),
    );

    assert.equal(curriculum.hasEasyFinishableQuest, true);
    assert.ok(curriculum.preferredActions.includes('quest_talk_accept'));
    assert.ok(curriculum.deprioritizedActions.includes('fish_cod'));
    assert.match(curriculum.hint, /Wood for the Hearth/i);
  });

  it('scores accepted hearth quest with gather_oak preferred over fish_cod', () => {
    const curriculum = evaluateQuestCurriculum(
      minimalSnapshot({
        acceptedQuests: [
          {
            title: 'Wood for the Hearth',
            progress: '42 / 150',
            canTurnIn: false,
            tab: 'accepted',
          },
        ],
        inventory: { 'Oak Log': 42 },
      }),
    );

    assert.equal(curriculum.topQuest?.title, 'Wood for the Hearth');
    assert.ok(curriculum.preferredActions.includes('gather_oak'));
    assert.ok(curriculum.deprioritizedActions.includes('fish_cod'));
    assert.ok(curriculum.interruptActions.includes('gather_oak'));
  });

  it('prefers quest_turnin when canTurnIn', () => {
    const curriculum = evaluateQuestCurriculum(
      minimalSnapshot({
        acceptedQuests: [
          { title: 'Wood for the Hearth', progress: '150 / 150', canTurnIn: true, tab: 'accepted' },
        ],
      }),
    );

    assert.equal(curriculum.preferredActions[0], 'quest_turnin');
    assert.equal(curriculum.topQuest?.importance, 100);
  });

  it('marks Goblin Menace hard at combat 1 and ranks below easy hearth gather', () => {
    const curriculum = evaluateQuestCurriculum(
      minimalSnapshot({
        combatLevel: 1,
        acceptedQuests: [
          { title: 'Goblin Menace', progress: '0 / 30', canTurnIn: false, tab: 'accepted' },
        ],
        pendingQuests: [{ title: 'Wood for the Hearth', canTurnIn: false, tab: 'pending' }],
      }),
    );

    const goblin = curriculum.scoredQuests.find((q) => q.title.includes('Goblin'));
    const hearth = curriculum.scoredQuests.find((q) => q.title.includes('Hearth'));
    assert.ok(goblin);
    assert.ok(hearth);
    assert.equal(goblin?.difficulty, 'hard');
    assert.equal(hearth?.difficulty, 'easy');
    assert.ok((hearth?.importance ?? 0) > (goblin?.importance ?? 0));
    assert.equal(curriculum.topQuest?.title, 'Wood for the Hearth');
  });

  it('rankQuestTitlesForPriority orders by importance', () => {
    const curriculum = evaluateQuestCurriculum(
      minimalSnapshot({
        combatLevel: 1,
        acceptedQuests: [
          { title: 'Goblin Menace', progress: '0 / 30', canTurnIn: false, tab: 'accepted' },
        ],
        pendingQuests: [{ title: 'Wood for the Hearth', canTurnIn: false, tab: 'pending' }],
      }),
    );
    const ranked = rankQuestTitlesForPriority(curriculum.scoredQuests);
    assert.equal(ranked[0], 'Wood for the Hearth');
  });
});


describe('progress-met turn-in inference', () => {
  it('treats accepted 150/150 as turn-in ready even when canTurnIn is false', () => {
    const curriculum = evaluateQuestCurriculum(
      minimalSnapshot({
        acceptedQuests: [
          { title: 'Wood for the Hearth', progress: '150 / 150', canTurnIn: false, tab: 'accepted' },
        ],
        pendingQuests: [],
      }),
    );
    assert.equal(curriculum.topQuest?.canTurnIn, true);
    assert.ok(curriculum.preferredActions.includes('quest_turnin'));
    assert.ok(curriculum.interruptActions.includes('quest_turnin'));
    assert.ok(curriculum.deprioritizedActions.includes('gather_oak'));
  });
});
