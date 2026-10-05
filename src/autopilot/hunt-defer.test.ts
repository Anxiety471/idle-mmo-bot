import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { GameSnapshot } from '../types.js';
import {
  deferredGatherStage,
  evaluatePlaybook,
  huntingDeferred,
  isKillQuestTitle,
} from './early-systems-playbook.js';

const KEYS = ['PLAYBOOK_STATE_PATH', 'EARLY_PLAYBOOK', 'HUNT_ENABLED', 'AUTOPILOT_LOG_DIR'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function counts(over: Record<string, number> = {}) {
  return {
    coal: 5500, rawCod: 149, cookedCod: 100, sells: 1, huntBattles: 24, mapPeeks: 1,
    petManages: 0, batchCycles: 1, coalBusyCycles: 0, codBusyCycles: 0, ...over,
  };
}

function snap(inventory: Record<string, number>, pendingTitles: string[] = []): GameSnapshot {
  return {
    location: 'Bluebell Hollow',
    pagePath: '/combat/battle',
    skillLevels: {},
    inventory,
    acceptedQuests: [],
    pendingQuests: pendingTitles.map((title) => ({ title, canTurnIn: false, tab: 'pending' as const })),
    combatPhase: 'none',
    flags: { hasBait: true, bankNearby: false, gatherBusy: false, inBattle: false, sessionValid: true },
    currentAction: { busy: false },
  } as GameSnapshot;
}

describe('round 9 hunt deferral (HUNT_ENABLED=false)', () => {
  let statePath = '';
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (statePath) rmSync(statePath, { force: true });
  });

  it('env + kill-quest helpers', () => {
    assert.equal(huntingDeferred({}), false);
    assert.equal(huntingDeferred({ HUNT_ENABLED: 'false' }), true);
    assert.equal(isKillQuestTitle('Goblin Menace'), true);
    assert.equal(isKillQuestTitle('Defeat 10 Ducks'), true);
    assert.equal(isKillQuestTitle('Gather Oak for the Mill'), false);
  });

  it('deferredGatherStage picks the resource furthest below target, with hysteresis', () => {
    const t = { coal: 100, cod: 100, cook: 100 };
    // every target met → never cook more; fish (lower than coal)
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 149, cooked: 103 }, t), 'fish_cod');
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 149, cooked: 40 }, t), 'cook_cod');
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 10, cooked: 300 }, t), 'fish_cod');
    assert.equal(deferredGatherStage({ coal: 20, rawCod: 200, cooked: 300 }, t), 'mine_coal');
    // cooking needs raw cod and coal
    assert.equal(deferredGatherStage({ coal: 500, rawCod: 0, cooked: 0 }, t), 'fish_cod');
    // keep the previous pick unless another is clearly lower
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 60, cooked: 50 }, t, 'fish_cod'), 'fish_cod');
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 90, cooked: 20 }, t, 'fish_cod'), 'cook_cod');
    // cooked met: a previous cook pick is dropped
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 149, cooked: 103 }, t, 'cook_cod'), 'fish_cod');
  });

  it('evaluatePlaybook defers the hunt stage, keeps the hunt count, prefers gathering, drops kill-quest talk', () => {
    statePath = join('/tmp', `playbook-hunt-defer-${process.pid}-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    process.env.HUNT_ENABLED = 'false';
    writeFileSync(statePath, `${JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: counts(), baitOwned: true })}\n`);
    const inv = { 'Coal Ore': 5500, 'Raw Cod': 149, 'Cooked Cod': 100, 'Cheap Bait': 5 };
    const p = evaluatePlaybook(snap(inv, ['Goblin Menace']));
    assert.equal(p.huntDeferred, true);
    assert.ok(['mine_coal', 'fish_cod', 'cook_cod'].includes(p.stage), p.stage);
    assert.equal(p.counts.huntBattles, 24);
    assert.equal(p.preferredActions[0], p.stage);
    for (const a of ['hunt_battle_batch', 'hunt_battle', 'quest_talk_accept']) {
      assert.ok(!p.preferredActions.includes(a as never), `${a} in ${p.preferredActions.join(',')}`);
    }
    assert.ok(p.preferredActions.includes('gather_oak'));
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { stage: string; deferredGatherStage?: string };
    assert.equal(persisted.stage, 'hunt_battle_batch');
    assert.equal(persisted.deferredGatherStage, p.stage);
  });

  it('a non-kill pending quest is talked to only after gathering', () => {
    statePath = join('/tmp', `playbook-hunt-defer2-${process.pid}-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    process.env.HUNT_ENABLED = 'false';
    writeFileSync(statePath, `${JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: counts(), baitOwned: true })}\n`);
    const p = evaluatePlaybook(snap({ 'Coal Ore': 5500, 'Raw Cod': 149, 'Cooked Cod': 100, 'Cheap Bait': 5 }, ['Gather Oak for the Mill']));
    assert.equal(p.huntDeferred, true);
    assert.equal(p.preferredActions.at(-1) === 'quest_talk_accept' || p.preferredActions.indexOf('quest_talk_accept') > 3, true);
  });

  it('hunting on: hunt stage unchanged', () => {
    statePath = join('/tmp', `playbook-hunt-on-${process.pid}-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    delete process.env.HUNT_ENABLED;
    writeFileSync(statePath, `${JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: counts(), baitOwned: true })}\n`);
    const p = evaluatePlaybook(snap({ 'Coal Ore': 5500, 'Raw Cod': 149, 'Cooked Cod': 100, 'Cheap Bait': 5 }));
    assert.equal(p.stage, 'hunt_battle_batch');
    assert.ok(!p.huntDeferred);
  });

  it('stays in the deferred loop after a cook snap-back and shows the hint', () => {
    statePath = join('/tmp', `playbook-hunt-defer3-${process.pid}-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    process.env.HUNT_ENABLED = 'false';
    writeFileSync(statePath, `${JSON.stringify({ version: 1, stage: 'cook_cod', deferredGatherStage: 'cook_cod', counts: counts({ cookedCod: 20 }), baitOwned: true })}\n`);
    const p = evaluatePlaybook(snap({ 'Coal Ore': 5500, 'Raw Cod': 149, 'Cooked Cod': 103, 'Cheap Bait': 5 }));
    assert.equal(p.huntDeferred, true);
    assert.equal(p.stage, 'fish_cod');
    assert.match(p.curriculumHint, /hunt deferred/);
  });
});
