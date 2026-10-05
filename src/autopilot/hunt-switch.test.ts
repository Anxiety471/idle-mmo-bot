import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutopilotActionId } from './action-types.js';
import { applyHuntSwitch, huntEnabled } from './action-registry.js';

const ids = (xs: string[]) => xs as AutopilotActionId[];

describe('round 9 HUNT_ENABLED switch', () => {
  it('defaults to enabled', () => {
    assert.equal(huntEnabled({}), true);
    assert.equal(huntEnabled({ HUNT_ENABLED: 'true' }), true);
    assert.equal(huntEnabled({ HUNT_ENABLED: 'false' }), false);
    assert.equal(huntEnabled({ HUNT_ENABLED: '0' }), false);
  });

  it('passes the playbook list through when hunting is on', () => {
    const f = ids(['hunt_battle_batch', 'quest_talk_accept']);
    assert.deepEqual(applyHuntSwitch(f, ids(['hunt_battle_batch', 'fish_cod']), {}), f);
  });

  it('drops hunt actions and adds back gather/fish/cook, never spend actions', () => {
    const filtered = ids(['hunt_battle_batch', 'hunt_battle', 'quest_talk_accept']);
    const raw = ids(['hunt_battle_batch', 'hunt_battle', 'hunt_rabbits', 'quest_talk_accept', 'fish_cod', 'cook_cod', 'gather_oak', 'buy_bait', 'sell_junk_for_gold', 'idle']);
    assert.deepEqual(applyHuntSwitch(filtered, raw, { HUNT_ENABLED: 'false' }), ids(['quest_talk_accept', 'fish_cod', 'cook_cod', 'gather_oak', 'idle']));
  });

  it('keeps a spend action the playbook itself allowed', () => {
    const out = applyHuntSwitch(ids(['sell_junk_for_gold', 'hunt_battle']), ids(['sell_junk_for_gold', 'hunt_battle']), { HUNT_ENABLED: 'false' });
    assert.deepEqual(out, ids(['sell_junk_for_gold']));
  });

  it('falls back to idle when nothing is left', () => {
    assert.deepEqual(applyHuntSwitch(ids(['hunt_battle']), ids(['hunt_battle']), { HUNT_ENABLED: 'false' }), ids(['idle']));
  });
});
