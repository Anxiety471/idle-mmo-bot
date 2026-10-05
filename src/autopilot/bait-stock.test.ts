import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { GameSnapshot } from '../types.js';
import {
  baitMinForFish,
  checkBaitStock,
  deferredGatherStage,
  evaluatePlaybook,
  filterAllowedByPlaybook,
  notePlaybookOutcome,
  shouldPreferBaitRestock,
} from './early-systems-playbook.js';

const KEYS = ['PLAYBOOK_STATE_PATH', 'EARLY_PLAYBOOK', 'HUNT_ENABLED', 'HEAL_FOOD_RESERVE', 'BAIT_MIN_FOR_FISH', 'BAIT_GOLD_FLOOR'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function counts(over: Record<string, number> = {}) {
  return {
    coal: 4500, rawCod: 89, cookedCod: 100, sells: 3, huntBattles: 14, mapPeeks: 1,
    petManages: 2, batchCycles: 7, coalBusyCycles: 0, codBusyCycles: 0, ...over,
  };
}

function snap(inventory: Record<string, number>, flags: Record<string, unknown> = {}, gold = 9000): GameSnapshot {
  return {
    location: 'Bluebell Hollow',
    pagePath: '/skills',
    skillLevels: {},
    inventory,
    gold,
    acceptedQuests: [],
    pendingQuests: [],
    combatPhase: 'none',
    flags: { hasBait: true, bankNearby: false, gatherBusy: false, inBattle: false, sessionValid: true, ...flags },
    currentAction: { busy: false },
  } as GameSnapshot;
}

const ALLOWED = ['fish_cod', 'buy_bait', 'mine_coal', 'gather_oak', 'cook_cod', 'idle', 'sell_junk_for_gold'] as never[];

describe('round 11 bait count', () => {
  let statePath = '';
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (statePath) rmSync(statePath, { force: true });
  });

  function setup(state: Record<string, unknown>) {
    statePath = join('/tmp', `playbook-bait-${process.pid}-${Date.now()}-${Math.random()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    delete process.env.HUNT_ENABLED;
    delete process.env.HEAL_FOOD_RESERVE;
    delete process.env.BAIT_MIN_FOR_FISH;
    process.env.BAIT_GOLD_FLOOR = '2000';
    writeFileSync(statePath, `${JSON.stringify({ version: 1, stage: 'fish_cod', counts: counts(), baitOwned: true, ...state })}\n`);
  }

  it('helpers: min bait, restock only below the heal reserve', () => {
    assert.equal(baitMinForFish({}), 15);
    assert.equal(baitMinForFish({ BAIT_MIN_FOR_FISH: '40' }), 40);
    assert.equal(shouldPreferBaitRestock('fish_cod', 1, undefined), true);
    assert.equal(shouldPreferBaitRestock('fish_cod', 1, undefined, 100, {}), false);
    assert.equal(shouldPreferBaitRestock('fish_cod', 1, undefined, 10, {}), true);
    assert.equal(shouldPreferBaitRestock('fish_cod', 50, undefined, 10, {}), false);
  });

  it('checkBaitStock: presence-fallback 1 is believed only after repeated fish failures', () => {
    const s = snap({ 'Cheap Bait': 1 }, { baitCountUntrusted: true });
    assert.deepEqual(checkBaitStock(s, undefined, 0, {}), { stock: 1, trusted: false, short: false });
    assert.equal(checkBaitStock(s, undefined, 3, {}).short, true);
    assert.equal(checkBaitStock(snap({ 'Cheap Bait': 1 }), undefined, 0, {}).short, true);
    assert.equal(checkBaitStock(snap({ 'Cheap Bait': 80 }), undefined, 5, {}).short, false);
    // fresh purchase in cooldown beats a low scrape
    assert.equal(checkBaitStock(snap({ 'Cheap Bait': 0 }), new Date().toISOString(), 5, {}).short, false);
    assert.equal(checkBaitStock(snap({ 'Cheap Bait': 0 }, { snapshotDegraded: true }), undefined, 5, {}).short, false);
  });

  it('deferredGatherStage never picks fish without bait', () => {
    const t = { coal: 100, cod: 100, cook: 100 };
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 10, cooked: 300 }, t, 'fish_cod', { noFish: true }), 'mine_coal');
    assert.equal(deferredGatherStage({ coal: 5500, rawCod: 149, cooked: 103 }, t, undefined, { noFish: true }), 'mine_coal');
  });

  it('KitaSan case: 1 bait, food above reserve → mine_coal/gather_oak, no fish_cod or buy_bait', () => {
    setup({ consecutiveFishCodFailures: 4 });
    const s = snap({ 'Coal Ore': 4500, 'Raw Cod': 89, 'Cooked Cod': 100, 'Cheap Bait': 1 });
    const p = evaluatePlaybook(s);
    assert.equal(p.baitShort, true);
    assert.equal(p.baitRestockForHeal, false);
    assert.equal(p.preferredActions[0], 'mine_coal');
    assert.ok(!p.preferredActions.includes('fish_cod' as never));
    assert.ok(!p.preferredActions.includes('buy_bait' as never));
    assert.match(p.curriculumHint, /bait low/);
    const allowed = filterAllowedByPlaybook(ALLOWED, s, p);
    assert.ok(!allowed.includes('fish_cod' as never), allowed.join(','));
    assert.ok(!allowed.includes('buy_bait' as never), allowed.join(','));
    assert.ok(allowed.includes('mine_coal' as never));
  });

  it('food below the reserve → restock bait (gold above floor) to fish for heals', () => {
    setup({});
    const s = snap({ 'Coal Ore': 4500, 'Raw Cod': 0, 'Cooked Cod': 10, 'Cheap Bait': 1 });
    const p = evaluatePlaybook(s);
    assert.equal(p.baitShort, false);
    assert.equal(p.baitRestockForHeal, true);
    assert.ok(p.preferredActions.includes('buy_bait' as never), p.preferredActions.join(','));
    const allowed = filterAllowedByPlaybook(ALLOWED, s, p);
    assert.ok(allowed.includes('buy_bait' as never), allowed.join(','));
  });

  it('food below the reserve but gold under the floor → no buy, no fish; mine instead', () => {
    setup({});
    const s = snap({ 'Coal Ore': 4500, 'Raw Cod': 0, 'Cooked Cod': 10, 'Cheap Bait': 1 }, {}, 500);
    const p = evaluatePlaybook(s);
    assert.equal(p.baitShort, true);
    const allowed = filterAllowedByPlaybook(ALLOWED, s, p);
    assert.ok(!allowed.includes('buy_bait' as never));
    assert.ok(!allowed.includes('fish_cod' as never));
  });

  it('plenty of bait: fishing unchanged', () => {
    setup({});
    const p = evaluatePlaybook(snap({ 'Coal Ore': 4500, 'Raw Cod': 20, 'Cooked Cod': 100, 'Cheap Bait': 80 }));
    assert.equal(p.baitShort, false);
    assert.equal(p.stage, 'fish_cod');
  });

  it('third fish failure with low bait is attributed to bait, not the UI backoff', () => {
    setup({ consecutiveFishCodFailures: 2, lastBaitStock: 1 });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => void warns.push(String(m));
    try {
      notePlaybookOutcome('fish_cod' as never, 'fishing_start_failed');
    } finally {
      console.warn = orig;
    }
    assert.ok(warns.some((w) => /bait re-check: Cheap Bait=1/.test(w)), warns.join('\n'));
    assert.ok(!warns.some((w) => /NOT missing bait/.test(w)), warns.join('\n'));
  });
});
