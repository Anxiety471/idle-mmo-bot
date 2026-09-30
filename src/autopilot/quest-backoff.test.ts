import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { notePlaybookOutcome, shouldSkipQuestTalkTitle } from './early-systems-playbook.js';

describe('per-quest talk backoff', () => {
  let statePath = '';
  afterEach(() => {
    if (statePath) rmSync(statePath, { force: true });
    delete process.env.PLAYBOOK_STATE_PATH;
  });

  it('backs off after 3 no_action and resets on a successful talk', () => {
    statePath = join('/tmp', `playbook-quest-backoff-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(statePath, JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: {} }));
    for (let i = 0; i < 3; i++) {
      notePlaybookOutcome('quest_talk_accept', 'talk:no_action:A Rabbits Fortune');
    }
    assert.equal(shouldSkipQuestTalkTitle("A Rabbit's Fortune"), true);
    notePlaybookOutcome('quest_talk_accept', 'card_not_opened');
    assert.equal(shouldSkipQuestTalkTitle('A Rabbits Fortune'), true);
    notePlaybookOutcome('quest_talk_accept', 'talk:talked:turned_in:turned_in');
    assert.equal(shouldSkipQuestTalkTitle('A Rabbits Fortune'), false);
  });
});
