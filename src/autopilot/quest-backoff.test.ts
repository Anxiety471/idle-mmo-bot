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

import { isQuestTalkFailureOutcome } from './early-systems-playbook.js';
import { talkEligiblePendingQuests } from './bootstrap-actions.js';

describe('quest talk failure backoff (round 5)', () => {
  it('card_not_opened twice skips that title; pending_tab_missing arms the global cooldown', () => {
    const statePath = join('/tmp', `playbook-card-backoff-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    writeFileSync(statePath, JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: {} }));
    notePlaybookOutcome('quest_talk_accept', 'card_not_opened:Scavengers of the Field');
    assert.equal(shouldSkipQuestTalkTitle('Scavengers of the Field'), false);
    notePlaybookOutcome('quest_talk_accept', 'card_not_opened:Scavengers of the Field');
    assert.equal(shouldSkipQuestTalkTitle('Scavengers of the Field'), true);
    notePlaybookOutcome('quest_talk_accept', 'pending_tab_missing');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(state.questTalkNoActionCycles > 0);
    rmSync(statePath, { force: true });
  });

  it('classifies no-progress outcomes', () => {
    for (const o of ['card_not_opened', 'card_not_opened:X', 'pending_tab_missing', 'already_accepted:X', 'detail_not_ready:X', 'talk:no_action:X']) {
      assert.equal(isQuestTalkFailureOutcome(o), true, o);
    }
    assert.equal(isQuestTalkFailureOutcome('talk:talked'), false);
  });

  it('excludes already-accepted quests from talk eligibility', () => {
    const statePath = join('/tmp', `playbook-eligible-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    writeFileSync(statePath, JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: {} }));
    const pending = [
      { title: 'Scavengers of the Field', progress: '15 / 15', canTurnIn: false, tab: 'pending' as const },
      { title: 'A Ducks Whisper', progress: '25 / 25', canTurnIn: false, tab: 'pending' as const },
    ];
    const accepted = [{ title: 'Scavengers of the Field', progress: '15 / 15', canTurnIn: true, tab: 'accepted' as const }];
    assert.deepEqual(talkEligiblePendingQuests(pending, accepted).map((q) => q.title), ['A Ducks Whisper']);
    rmSync(statePath, { force: true });
  });
});
