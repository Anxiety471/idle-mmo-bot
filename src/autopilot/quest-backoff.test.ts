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

import { readFileSync } from 'node:fs';
import { dropQuestTurninDuringCooldown, QUEST_TURNIN_FAIL_COOLDOWN } from './early-systems-playbook.js';

describe('quest_turnin failure cooldown', () => {
  it('arms on turnin_failed, clears on success, and drops quest_turnin from allowed', () => {
    const statePath = join('/tmp', `playbook-turnin-backoff-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    writeFileSync(statePath, JSON.stringify({ version: 1, stage: 'cook_cod', counts: {} }));
    notePlaybookOutcome('quest_turnin', 'turnin_failed');
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).questTurninFailCycles, QUEST_TURNIN_FAIL_COOLDOWN);
    notePlaybookOutcome('quest_turnin', 'turned_in');
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).questTurninFailCycles, 0);
    rmSync(statePath, { force: true });

    assert.deepEqual(
      dropQuestTurninDuringCooldown(['quest_turnin', 'cook_cod'], { questTurninFailCycles: 2 }),
      ['cook_cod'],
    );
    assert.deepEqual(
      dropQuestTurninDuringCooldown(['quest_turnin', 'cook_cod'], { questTurninFailCycles: 0 }),
      ['quest_turnin', 'cook_cod'],
    );

  });
});
