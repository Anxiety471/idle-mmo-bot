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

const KEYS = ['PLAYBOOK_STATE_PATH', 'EARLY_PLAYBOOK', 'HUNT_ENABLED', 'HEAL_FOOD_RESERVE', 'BAIT_MIN_FOR_FISH', 'BAIT_GOLD_FLOOR', 'SELL_SWEEP'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const context: AutopilotContext = { cycle: 2, gatherRotationIndex: 0 };

/** KitaSan's logs-kita-san/playbook-state.json after cycle 2 on c9a8d4f (sell cooldown expired). */
function kitaState(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    stage: 'fish_cod',
    counts: {
      coal: 4500, rawCod: 89, cookedCod: 100, sells: 3, huntBattles: 14, mapPeeks: 1,
      petManages: 2, batchCycles: 7, coalBusyCycles: 1, codBusyCycles: 16,
    },
    baitOwned: true,
    lastBaitPurchaseAt: '2026-10-05T02:04:45.463Z',
    lastGatherRestartAt: '2026-10-05T02:07:13.873Z',
    lastGatherSkill: 'fishing',
    lastGatherResource: 'Cod',
    consecutiveFishCodFailures: 7,
    lastBaitStock: 0,
    lastCoalProgressSeen: 6200,
    staleCoalBusyCycles: 0,
    questTalkNoActionCycles: 0,
    questTurninFailCycles: 0,
    questTalkSkipCycles: {},
    questTalkNoActionByTitle: { 'the goblins hoard': 0 },
    lastSellAttemptAt: '2026-10-05T01:00:00.000Z',
    ...over,
  };
}

/** KitaSan's cycle-2 snapshot (decisions.jsonl 02:44:52Z), raw scrape: no bait. */
function kitaSnap(inventory: Record<string, number> = {}, flags: Record<string, unknown> = {}): GameSnapshot {
  return {
    location: 'Bluebell Hollow',
    pagePath: '/skills',
    skillLevels: {},
    gold: 11398,
    inventory: { 'Oak Log': 200, 'Coal Ore': 4200, 'Cooked Cod': 100, 'Raw Cod': 89, ...inventory },
    acceptedQuests: [{ title: 'Fuel for the Forge', progress: '0 / 100', canTurnIn: false, tab: 'accepted' }],
    pendingQuests: [{ title: 'The Goblins Hoard', canTurnIn: false, tab: 'pending' }],
    combatPhase: 'none',
    flags: { hasBait: true, bankNearby: false, gatherBusy: false, inBattle: false, sessionValid: true, ...flags },
    currentAction: { busy: false },
  } as GameSnapshot;
}

/** Cycle-2 allowed list from KitaSan's log (registry output before the playbook filter). */
const RAW: AutopilotAction[] = [
  'quest_talk_accept', 'mine_coal', 'gather_oak', 'idle', 'craft_if_ready', 'explore_map',
  'sell_junk', 'sell_junk_for_gold', 'gather_yew', 'fish_cod', 'buy_bait', 'continue_current',
] as AutopilotAction[];

describe('round 11b: sticky bait-missing (KitaSan repro)', () => {
  let statePath = '';
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (statePath) rmSync(statePath, { force: true });
  });

  function setup(state: Record<string, unknown>) {
    statePath = join('/tmp', `playbook-bait-sticky-${process.pid}-${Date.now()}-${Math.random()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    process.env.HUNT_ENABLED = 'false';
    process.env.HEAL_FOOD_RESERVE = '35';
    process.env.BAIT_GOLD_FLOOR = '2000';
    delete process.env.BAIT_MIN_FOR_FISH;
    delete process.env.SELL_SWEEP;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  }
  const persisted = () => JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;

  async function choose(raw: GameSnapshot) {
    const p = evaluatePlaybook(raw);
    const snap = attachPlaybookToSnapshot(raw, p);
    const allowed = applyHuntSwitch(filterAllowedByPlaybook(RAW, snap, p), RAW);
    const finalAllowed = p.baitShort ? allowed.filter((a) => a !== 'fish_cod' && a !== 'buy_bait') : allowed;
    const action = await new ProgressiveStubJev().chooseNextAction(snap, finalAllowed, context);
    return { p, allowed: finalAllowed, action };
  }

  it('cycle 2: bait short persists, baitOwned cleared, chooses mine_coal (not sell/idle/fish)', async () => {
    setup(kitaState());
    const { p, allowed, action } = await choose(kitaSnap());
    assert.equal(p.baitShort, true);
    assert.equal(p.baitOwned, false);
    assert.equal(p.sellSurplusDue, true); // sweep due, but bait-missing gather wins
    assert.ok(!allowed.includes('fish_cod' as AutopilotAction), allowed.join(','));
    assert.ok(allowed.includes('mine_coal' as AutopilotAction), allowed.join(','));
    assert.equal(action, 'mine_coal');
    const st = persisted();
    assert.equal(st.baitOwned, false);
    assert.equal(typeof st.baitShortSince, 'string');
    assert.equal(st.stage, 'fish_cod');
  });

  it('sticky: next cycle with a presence-fallback bait=1 and failures reset still mines', async () => {
    setup(kitaState({ baitOwned: false, consecutiveFishCodFailures: 0, baitShortSince: '2026-10-05T02:40:00.000Z' }));
    const { p, action } = await choose(kitaSnap({ 'Cheap Bait': 1 }, { baitCountUntrusted: true }));
    assert.equal(p.baitShort, true);
    assert.equal(action, 'mine_coal');
    assert.equal(persisted().baitShortSince, '2026-10-05T02:40:00.000Z');
  });

  it('already mining coal → continue_current', async () => {
    setup(kitaState({ baitOwned: false, baitShortSince: '2026-10-05T02:40:00.000Z' }));
    const raw = kitaSnap({}, { gatherBusy: true });
    raw.currentAction = { busy: true, resource: 'Coal Ore', label: 'Coal Ore' } as GameSnapshot['currentAction'];
    const { action } = await choose(raw);
    assert.equal(action, 'continue_current');
  });

  it('a real count >= BAIT_MIN_FOR_FISH clears it; fishing resumes', async () => {
    setup(kitaState({ baitOwned: false, consecutiveFishCodFailures: 0, baitShortSince: '2026-10-05T02:40:00.000Z', lastSellAttemptAt: new Date().toISOString() }));
    const { p, action } = await choose(kitaSnap({ 'Cheap Bait': 60, 'Raw Cod': 20 }));
    assert.equal(p.baitShort, false);
    assert.equal(persisted().baitShortSince, undefined);
    assert.equal(action, 'fish_cod');
  });

  it('a successful buy clears it', () => {
    setup(kitaState({ baitOwned: false, baitShortSince: '2026-10-05T02:40:00.000Z' }));
    notePlaybookOutcome('buy_bait' as AutopilotAction, 'purchased');
    const st = persisted();
    assert.equal(st.baitShortSince, undefined);
    assert.equal(st.baitOwned, true);
  });

  it('the 3rd failed fish with low bait records baitShortSince and clears baitOwned', () => {
    setup(kitaState({ consecutiveFishCodFailures: 2, lastBaitStock: 0 }));
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      notePlaybookOutcome('fish_cod' as AutopilotAction, 'fishing_start_failed');
    } finally {
      console.warn = warn;
    }
    const st = persisted();
    assert.equal(typeof st.baitShortSince, 'string');
    assert.equal(st.baitOwned, false);
  });

  it('food below the reserve → restock bait instead of mining', async () => {
    setup(kitaState({ baitOwned: false, baitShortSince: '2026-10-05T02:40:00.000Z', lastSellAttemptAt: new Date().toISOString() }));
    const { p, allowed, action } = await choose(kitaSnap({ 'Cooked Cod': 10, 'Cheap Bait': 1 }, { baitCountUntrusted: true }));
    assert.equal(p.baitRestockForHeal, true);
    assert.ok(allowed.includes('buy_bait' as AutopilotAction), allowed.join(','));
    assert.equal(action, 'buy_bait');
  });
});
