import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';
import { ProgressiveStubJev } from '../jev/progressive-stub.js';
import { applyHuntSwitch } from './action-registry.js';
import {
  attachPlaybookToSnapshot,
  evaluatePlaybook,
  filterAllowedByPlaybook,
  notePlaybookOutcome,
} from './early-systems-playbook.js';

const KEYS = [
  'PLAYBOOK_STATE_PATH',
  'EARLY_PLAYBOOK',
  'HUNT_ENABLED',
  'HEAL_FOOD_RESERVE',
  'BAIT_MIN_FOR_FISH',
  'BAIT_GOLD_FLOOR',
  'SELL_SWEEP',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const context: AutopilotContext = { cycle: 2, gatherRotationIndex: 0 };

const RAW: AutopilotAction[] = [
  'quest_talk_accept',
  'mine_coal',
  'gather_oak',
  'idle',
  'craft_if_ready',
  'explore_map',
  'sell_junk',
  'sell_junk_for_gold',
  'gather_yew',
  'fish_cod',
  'buy_bait',
  'continue_current',
  'cook_cod',
  'hunt_battle_batch',
  'hunt_battle',
  'hunt_rabbits',
  'equip_pet',
] as AutopilotAction[];

function baitShortFields(over: Record<string, unknown> = {}) {
  return {
    baitOwned: false,
    lastBaitPurchaseAt: '2026-10-04T23:03:13.948Z',
    consecutiveFishCodFailures: 1,
    lastBaitStock: 0,
    baitShortSince: '2026-10-05T03:02:37.158Z',
    lastSellAttemptAt: new Date().toISOString(),
    ...over,
  };
}

function snap(inventory: Record<string, number>, gold = 24000): GameSnapshot {
  return {
    location: 'Bluebell Hollow',
    pagePath: '/skills',
    skillLevels: {},
    gold,
    inventory: { 'Oak Log': 50, 'Coal Ore': 4500, 'Cheap Bait': 0, ...inventory },
    acceptedQuests: [],
    pendingQuests: [],
    combatPhase: 'none',
    flags: { hasBait: false, bankNearby: false, gatherBusy: false, inBattle: false, sessionValid: true },
    currentAction: { busy: false },
  } as GameSnapshot;
}

describe('round 11c: bait-short stage scope (hunt on vs hunt deferred)', () => {
  let statePath = '';
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (statePath) rmSync(statePath, { force: true });
  });

  function setup(huntEnabled: string, state: Record<string, unknown>) {
    statePath = join('/tmp', `playbook-bait-scope-${process.pid}-${Date.now()}-${Math.random()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    process.env.HUNT_ENABLED = huntEnabled;
    process.env.HEAL_FOOD_RESERVE = '35';
    process.env.BAIT_GOLD_FLOOR = '2000';
    delete process.env.BAIT_MIN_FOR_FISH;
    delete process.env.SELL_SWEEP;
    writeFileSync(statePath, `${JSON.stringify({ version: 1, ...state })}\n`);
  }

  async function choose(raw: GameSnapshot) {
    const p = evaluatePlaybook(raw);
    const attached = attachPlaybookToSnapshot(raw, p);
    let allowed = applyHuntSwitch(filterAllowedByPlaybook(RAW, attached, p), RAW);
    // Mirror deriveAllowedActions Round 11b post-filter.
    if (p.baitShort) {
      allowed = allowed.filter((a) => a !== 'fish_cod' && a !== 'buy_bait');
      for (const a of ['mine_coal', 'gather_oak'] as AutopilotAction[]) {
        if (p.stage === 'fish_cod' && RAW.includes(a) && !allowed.includes(a)) allowed.push(a);
      }
    }
    const action = await new ProgressiveStubJev().chooseNextAction(attached, allowed, context);
    return { p, allowed, action };
  }

  // --- Rule 1: HUNT_ENABLED=false — gather-only sticky bait-missing (intentional) ---

  it('rule1: HUNT off + bait short + cooked >= reserve → mine/oak, buy_bait NOT allowed', async () => {
    setup('false', {
      stage: 'hunt_battle_batch',
      counts: {
        coal: 11200, rawCod: 0, cookedCod: 108, sells: 4, huntBattles: 81, mapPeeks: 1,
        petManages: 1, batchCycles: 9, coalBusyCycles: 100, codBusyCycles: 50,
      },
      ...baitShortFields(),
    });
    const { p, allowed, action } = await choose(snap({ 'Cooked Cod': 108, 'Raw Cod': 0, 'Coal Ore': 11200 }));
    assert.equal(p.huntDeferred, true);
    assert.equal(p.baitShort, true);
    assert.equal(p.baitRestockForHeal, false);
    assert.equal(p.stage, 'mine_coal');
    assert.equal(p.preferredActions[0], 'mine_coal');
    assert.ok(!allowed.includes('buy_bait' as AutopilotAction), allowed.join(','));
    assert.ok(!allowed.includes('fish_cod' as AutopilotAction), allowed.join(','));
    assert.equal(action, 'mine_coal');
  });

  it('rule1: HUNT off + bait short + cooked < reserve → buy_bait allowed and preferred', async () => {
    setup('false', {
      stage: 'fish_cod',
      counts: {
        coal: 4500, rawCod: 20, cookedCod: 10, sells: 3, huntBattles: 0, mapPeeks: 0,
        petManages: 0, batchCycles: 0, coalBusyCycles: 0, codBusyCycles: 0,
      },
      ...baitShortFields(),
    });
    const { p, allowed, action } = await choose(snap({ 'Cooked Cod': 10, 'Raw Cod': 20, 'Coal Ore': 4500 }));
    assert.equal(p.baitRestockForHeal, true);
    assert.equal(p.baitShort, false);
    assert.ok(allowed.includes('buy_bait' as AutopilotAction), allowed.join(','));
    assert.equal(action, 'buy_bait');
  });

  // --- Rule 2: hunting ON — bait short must not override hunt/cook ---

  it('rule2: HUNT on + hunt_battle_batch + bait short + cooked enough → hunt, not mine', async () => {
    setup('true', {
      stage: 'hunt_battle_batch',
      // rawCod soft latch often clamps to 0 after cooking; must not demote hunt → fish → mine.
      counts: {
        coal: 4500, rawCod: 0, cookedCod: 108, sells: 3, huntBattles: 40, mapPeeks: 1,
        petManages: 1, batchCycles: 2, coalBusyCycles: 10, codBusyCycles: 10,
      },
      ...baitShortFields(),
    });
    const { p, allowed, action } = await choose(snap({ 'Cooked Cod': 108, 'Raw Cod': 0, 'Coal Ore': 4500 }));
    assert.equal(p.huntDeferred, false);
    assert.equal(p.baitShort, true);
    assert.equal(p.stage, 'hunt_battle_batch');
    assert.equal(p.preferredActions[0], 'hunt_battle_batch');
    assert.ok(allowed.includes('hunt_battle_batch' as AutopilotAction), allowed.join(','));
    assert.ok(!allowed.includes('fish_cod' as AutopilotAction), allowed.join(','));
    assert.notEqual(action, 'mine_coal');
    assert.equal(action, 'hunt_battle_batch');
  });

  it('rule2: HUNT on + cook_cod + bait short + fishMet → cook, not mine', async () => {
    setup('true', {
      stage: 'cook_cod',
      counts: {
        coal: 4500, rawCod: 150, cookedCod: 40, sells: 3, huntBattles: 0, mapPeeks: 0,
        petManages: 0, batchCycles: 0, coalBusyCycles: 0, codBusyCycles: 0,
      },
      ...baitShortFields(),
    });
    const { p, allowed, action } = await choose(snap({ 'Cooked Cod': 40, 'Raw Cod': 120, 'Coal Ore': 4500 }));
    assert.equal(p.huntDeferred, false);
    assert.equal(p.baitShort, true);
    assert.equal(p.stage, 'cook_cod');
    assert.equal(p.preferredActions[0], 'cook_cod');
    assert.ok(allowed.includes('cook_cod' as AutopilotAction), allowed.join(','));
    assert.ok(!allowed.includes('fish_cod' as AutopilotAction), allowed.join(','));
    assert.notEqual(action, 'mine_coal');
    assert.equal(action, 'cook_cod');
  });

  it('rule2: HUNT on + true fish_cod + bait short + cooked >= reserve → mine/oak still OK', async () => {
    setup('true', {
      stage: 'fish_cod',
      counts: {
        coal: 4500, rawCod: 20, cookedCod: 100, sells: 3, huntBattles: 0, mapPeeks: 0,
        petManages: 0, batchCycles: 0, coalBusyCycles: 0, codBusyCycles: 0,
      },
      ...baitShortFields(),
    });
    const { p, allowed, action } = await choose(snap({ 'Cooked Cod': 100, 'Raw Cod': 20, 'Coal Ore': 4500 }));
    assert.equal(p.stage, 'fish_cod');
    assert.equal(p.baitShort, true);
    assert.equal(p.preferredActions[0], 'mine_coal');
    assert.ok(!allowed.includes('buy_bait' as AutopilotAction), allowed.join(','));
    assert.ok(!allowed.includes('fish_cod' as AutopilotAction), allowed.join(','));
    assert.equal(action, 'mine_coal');
  });

  // --- Rule 3: do not re-enable hunting via this patch (env stays as set) ---

  it('rule3: patch does not flip HUNT_ENABLED — deferred stays deferred', async () => {
    setup('false', {
      stage: 'hunt_battle_batch',
      counts: {
        coal: 5000, rawCod: 150, cookedCod: 108, sells: 3, huntBattles: 40, mapPeeks: 1,
        petManages: 1, batchCycles: 2, coalBusyCycles: 10, codBusyCycles: 10,
      },
      ...baitShortFields({ baitOwned: true, baitShortSince: undefined, lastBaitStock: 80 }),
    });
    const { p } = await choose(
      snap({ 'Cooked Cod': 108, 'Raw Cod': 50, 'Coal Ore': 5000, 'Cheap Bait': 80 }),
    );
    assert.equal(process.env.HUNT_ENABLED, 'false');
    assert.equal(p.huntDeferred, true);
    assert.notEqual(p.stage, 'hunt_battle_batch');
  });

  it('sticky baitOwned after buy still clears baitShortSince', () => {
    setup('false', {
      stage: 'fish_cod',
      counts: {
        coal: 4500, rawCod: 20, cookedCod: 100, sells: 3, huntBattles: 0, mapPeeks: 0,
        petManages: 0, batchCycles: 0, coalBusyCycles: 0, codBusyCycles: 0,
      },
      ...baitShortFields(),
    });
    notePlaybookOutcome('buy_bait' as AutopilotAction, 'purchased');
    const st = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    assert.equal(st.baitShortSince, undefined);
    assert.equal(st.baitOwned, true);
  });
});
