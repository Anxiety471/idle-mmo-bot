import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getLogDir } from '../logging/jsonl-writer.js';
import type { AutopilotContext, GameSnapshot, GatherState } from '../types.js';
import {
  coalTargetMet,
  cookTargetMet,
  evaluatePlaybook,
  filterAllowedByPlaybook,
  fishTargetMet,
  FISH_COD_BACKOFF_MS,
  FISH_COD_FAILURE_THRESHOLD,
  huntTargetMet,
  normalizeEarlyStageId,
  notePlaybookOutcome,
  QUEST_TALK_NO_ACTION_COOLDOWN,
  recentBaitPurchase,
  resolvePlaybookStatePath,
  shouldInjectAsyncPets,
  shouldInjectEquipPet,
  shouldInterruptGatherForPlaybook,
  shouldPreferBaitRestock,
  STALE_COAL_BUSY_CYCLES,
  updateStaleCoalBusyTracking,
  type PlaybookProgress,
} from './early-systems-playbook.js';
import { ProgressiveStubJev } from '../jev/progressive-stub.js';

const ENV_KEYS = ['AUTOPILOT_LOG_DIR', 'PLAYBOOK_STATE_PATH', 'EARLY_PLAYBOOK'] as const;

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function emptyPlaybookCounts() {
  return {
    coal: 0,
    rawCod: 0,
    cookedCod: 0,
    sells: 0,
    huntBattles: 0,
    mapPeeks: 0,
    petManages: 0,
    batchCycles: 0,
    coalBusyCycles: 0,
    codBusyCycles: 0,
  };
}

/** Counts that satisfy the default PLAYBOOK_COAL_TARGET (100). */
function coalMetCounts(overrides: Record<string, number> = {}) {
  return { ...emptyPlaybookCounts(), coal: 100, coalBusyCycles: 300, ...overrides };
}

function minimalSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    location: 'Melriel',
    pagePath: '/fishing',
    skillLevels: {},
    inventory: { 'Cheap Bait': 5 },
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

function fishCodPlaybook(overrides: Partial<PlaybookProgress> = {}): PlaybookProgress {
  return {
    enabled: true,
    stage: 'fish_cod',
    stageIndex: 3,
    stageGoal: 'Fish Cod',
    preferredActions: ['fish_cod', 'continue_current'],
    deprioritizedActions: ['gather_oak', 'gather_yew', 'mine_coal'],
    interruptActions: ['fish_cod'],
    counts: emptyPlaybookCounts(),
    baitOwned: true,
    targets: { coalMin: 100, coalMax: 100, codMin: 100, codMax: 100, cookMin: 100, huntMin: 120 },
    curriculumHint: 'fish',
    complete: false,
    gatherGraceActive: true,
    gatherGraceSkill: 'fishing',
    gatherGraceResource: 'Cod',
    fishCodBackoffActive: false,
    consecutiveFishCodFailures: 0,
    staleCoalGather: false,
    staleCoalBusyCycles: 0,
    ...overrides,
  };
}

describe('resolvePlaybookStatePath', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('defaults to playbook-state.json under getLogDir()', () => {
    delete process.env.PLAYBOOK_STATE_PATH;
    process.env.AUTOPILOT_LOG_DIR = '/tmp/character-a/logs';

    assert.equal(resolvePlaybookStatePath(), join(getLogDir(), 'playbook-state.json'));
    assert.equal(resolvePlaybookStatePath(), '/tmp/character-a/logs/playbook-state.json');
  });

  it('honors PLAYBOOK_STATE_PATH when set', () => {
    process.env.PLAYBOOK_STATE_PATH = '/custom/playbook-state.json';
    process.env.AUTOPILOT_LOG_DIR = '/tmp/character-b/logs';

    assert.equal(resolvePlaybookStatePath(), '/custom/playbook-state.json');
  });
});

describe('gather grace', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath: string;

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) {
      rmSync(statePath, { force: true });
    }
  });

  it('filterAllowedByPlaybook drops continue_current for easy-complete pending accept', () => {
    const playbook = fishCodPlaybook();
    const snapshot = minimalSnapshot({
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: true,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: { busy: true, skill: 'woodcutting', resource: 'Oak Log' },
      pendingQuests: [
        {
          title: 'Wood for the Hearth',
          progress: '150 / 150',
          canTurnIn: false,
          tab: 'pending',
        },
      ],
    });
    const allowed: string[] = ['continue_current', 'quest_talk_accept', 'fish_cod', 'idle'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.ok(filtered.includes('quest_talk_accept'));
    assert.ok(!filtered.includes('continue_current'));
  });

  it('filterAllowedByPlaybook skips fish_cod re-injection during grace', () => {
    const playbook = fishCodPlaybook();
    const snapshot = minimalSnapshot();
    const allowed: string[] = ['idle', 'continue_current'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.ok(!filtered.includes('fish_cod'));
    assert.ok(filtered.includes('continue_current'));
  });

  it('notePlaybookOutcome sets gather grace fields on fish_cod restarted', () => {
    statePath = join('/tmp', `playbook-grace-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, stage: 'fish_cod', counts: emptyPlaybookCounts(), baitOwned: true })}\n`,
    );

    notePlaybookOutcome('fish_cod', 'restarted');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      lastGatherRestartAt?: string;
      lastGatherSkill?: string;
      lastGatherResource?: string;
    };
    assert.ok(saved.lastGatherRestartAt);
    assert.equal(saved.lastGatherSkill, 'fishing');
    assert.equal(saved.lastGatherResource, 'Cod');
  });

  it('evaluatePlaybook credits codBusyCycles during fish_cod grace', () => {
    statePath = join('/tmp', `playbook-grace-eval-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    mkdirSync('/tmp', { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: { ...coalMetCounts(), codBusyCycles: 5 },
        baitOwned: true,
        lastGatherRestartAt: new Date().toISOString(),
        lastGatherSkill: 'fishing',
        lastGatherResource: 'Cod',
      })}\n`,
    );

    const progress = evaluatePlaybook(minimalSnapshot());

    assert.equal(progress.gatherGraceActive, true);
    assert.equal(progress.counts.codBusyCycles, 6);
  });
});

describe('sticky baitOwned (no repurchase loop)', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath: string;

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  it('notePlaybookOutcome does not clear baitOwned on fish_cod missing_requirement', () => {
    statePath = join('/tmp', `playbook-sticky-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: emptyPlaybookCounts(),
        baitOwned: true,
        lastBaitPurchaseAt: new Date().toISOString(),
      })}\n`,
    );

    notePlaybookOutcome('fish_cod', 'missing_requirement');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      baitOwned?: boolean;
      stage?: string;
    };
    assert.equal(saved.baitOwned, true);
    assert.equal(saved.stage, 'fish_cod');
  });

  it('filterAllowedByPlaybook strips buy_bait when baitOwned even if stage is buy_bait', () => {
    const playbook = fishCodPlaybook({
      stage: 'buy_bait',
      stageIndex: 2,
      preferredActions: ['buy_bait'],
      interruptActions: ['buy_bait'],
      baitOwned: true,
      gatherGraceActive: false,
      lastBaitPurchaseAt: new Date().toISOString(),
    });
    const snapshot = minimalSnapshot({
      flags: {
        hasBait: false,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
      inventory: {},
    });
    const allowed = ['buy_bait', 'fish_cod', 'idle', 'continue_current'];
    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);
    assert.ok(!filtered.includes('buy_bait'), `buy_bait should be stripped, got ${filtered.join(',')}`);
    assert.ok(filtered.includes('fish_cod') || filtered.includes('idle'));
  });

  it('notePlaybookOutcome records lastBaitPurchaseAt on purchased', () => {
    statePath = join('/tmp', `playbook-buy-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, stage: 'buy_bait', counts: coalMetCounts(), baitOwned: false })}\n`,
    );
    notePlaybookOutcome('buy_bait', 'purchased');
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      baitOwned?: boolean;
      stage?: string;
      lastBaitPurchaseAt?: string;
    };
    assert.equal(saved.baitOwned, true);
    assert.equal(saved.stage, 'fish_cod');
    assert.ok(saved.lastBaitPurchaseAt);
  });

  it('notePlaybookOutcome does not clear baitOwned on fish_cod failed', () => {
    statePath = join('/tmp', `playbook-failed-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: emptyPlaybookCounts(),
        baitOwned: true,
      })}\n`,
    );

    notePlaybookOutcome('fish_cod', 'failed');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      baitOwned?: boolean;
      stage?: string;
      consecutiveFishCodFailures?: number;
    };
    assert.equal(saved.baitOwned, true);
    assert.equal(saved.stage, 'fish_cod');
    assert.equal(saved.consecutiveFishCodFailures, 1);
  });

  it('notePlaybookOutcome enters fish_cod backoff after threshold failures', () => {
    statePath = join('/tmp', `playbook-backoff-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: emptyPlaybookCounts(),
        baitOwned: true,
        consecutiveFishCodFailures: FISH_COD_FAILURE_THRESHOLD - 1,
      })}\n`,
    );

    notePlaybookOutcome('fish_cod', 'fishing_start_failed');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      consecutiveFishCodFailures?: number;
      fishCodBackoffUntil?: string;
      baitOwned?: boolean;
    };
    assert.equal(saved.consecutiveFishCodFailures, FISH_COD_FAILURE_THRESHOLD);
    assert.ok(saved.fishCodBackoffUntil);
    assert.equal(saved.baitOwned, true);
    const remaining = new Date(saved.fishCodBackoffUntil!).getTime() - Date.now();
    assert.ok(remaining > 0 && remaining <= FISH_COD_BACKOFF_MS);
  });

  it('filterAllowedByPlaybook skips fish_cod during backoff and injects fallbacks', () => {
    const until = new Date(Date.now() + FISH_COD_BACKOFF_MS).toISOString();
    const playbook = fishCodPlaybook({
      gatherGraceActive: false,
      fishCodBackoffActive: true,
      fishCodBackoffUntil: until,
      consecutiveFishCodFailures: FISH_COD_FAILURE_THRESHOLD,
    });
    const snapshot = minimalSnapshot();
    const allowed: string[] = ['fish_cod', 'idle', 'continue_current', 'mine_coal', 'cook_cod'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.ok(!filtered.includes('fish_cod'));
    assert.ok(filtered.includes('continue_current'));
    assert.ok(filtered.includes('mine_coal'));
    assert.ok(filtered.includes('cook_cod'));
  });

  it('notePlaybookOutcome resets fish_cod failure counter on restarted', () => {
    statePath = join('/tmp', `playbook-reset-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: emptyPlaybookCounts(),
        baitOwned: true,
        consecutiveFishCodFailures: 3,
        fishCodBackoffUntil: new Date(Date.now() + 60_000).toISOString(),
      })}\n`,
    );

    notePlaybookOutcome('fish_cod', 'restarted');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      consecutiveFishCodFailures?: number;
      fishCodBackoffUntil?: string;
    };
    assert.equal(saved.consecutiveFishCodFailures, 0);
    assert.equal(saved.fishCodBackoffUntil, undefined);
  });

  it('notePlaybookOutcome counts sell_junk_for_gold sells', () => {
    statePath = join('/tmp', `playbook-sell-junk-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, stage: 'sell_half', counts: emptyPlaybookCounts(), baitOwned: false })}\n`,
    );

    notePlaybookOutcome('sell_junk_for_gold', 'sold');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { counts?: { sells?: number } };
    assert.equal(saved.counts?.sells, 1);
  });

  it('notePlaybookOutcome credits hunt_battle_batch on battle outcome', () => {
    statePath = join('/tmp', `playbook-hunt-credit-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: emptyPlaybookCounts(), baitOwned: true })}\n`,
    );

    notePlaybookOutcome(
      'hunt_battle_batch',
      'battle:battle_started:huntMore:hunt_more_clicked',
    );

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { counts?: { huntBattles?: number } };
    assert.equal(saved.counts?.huntBattles, 1);
  });

  it('notePlaybookOutcome does not credit hunt_rabbits on hunt_metrics_pending', () => {
    statePath = join('/tmp', `playbook-hunt-pending-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, stage: 'hunt_battle_batch', counts: emptyPlaybookCounts(), baitOwned: true })}\n`,
    );

    notePlaybookOutcome('hunt_battle_batch', 'hunt_metrics_pending');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { counts?: { huntBattles?: number } };
    assert.equal(saved.counts?.huntBattles, 0);
  });
});

describe('missions-first early gold', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath: string;

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  function sellHalfPlaybook(overrides: Partial<PlaybookProgress> = {}): PlaybookProgress {
    return {
      enabled: true,
      stage: 'sell_half',
      stageIndex: 1,
      stageGoal: 'Sell half',
      preferredActions: ['sell_junk_for_gold', 'market_sell_half', 'sell_junk'],
      deprioritizedActions: ['gather_oak', 'gather_yew', 'mine_coal'],
      interruptActions: ['sell_junk_for_gold', 'market_sell_half', 'sell_junk'],
      counts: emptyPlaybookCounts(),
      baitOwned: false,
      targets: { coalMin: 100, coalMax: 100, codMin: 100, codMax: 100, cookMin: 100, huntMin: 120 },
      curriculumHint: 'sell',
      complete: false,
      gatherGraceActive: false,
      fishCodBackoffActive: false,
      consecutiveFishCodFailures: 0,
      staleCoalGather: false,
      staleCoalBusyCycles: 0,
      ...overrides,
    };
  }

  it('filterAllowedByPlaybook puts quest_turnin before sell_junk_for_gold when turn-in ready and both allowed', () => {
    const playbook = sellHalfPlaybook({
      preferredActions: [
        'quest_turnin',
        'sell_junk_for_gold',
        'market_sell_half',
        'sell_junk',
      ],
    });
    const snapshot = minimalSnapshot({
      acceptedQuests: [{ title: 'Wood for the Hearth', canTurnIn: true, tab: 'accepted' }],
      pendingQuests: [],
    });
    const allowed = ['sell_junk_for_gold', 'quest_turnin', 'idle'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.equal(filtered[0], 'quest_turnin');
    assert.ok(filtered.indexOf('quest_turnin') < filtered.indexOf('sell_junk_for_gold'));
  });

  it('filterAllowedByPlaybook puts quest_talk_accept before market_sell_half when pending quests', () => {
    const playbook = sellHalfPlaybook({
      preferredActions: [
        'quest_talk_accept',
        'sell_junk_for_gold',
        'market_sell_half',
        'sell_junk',
      ],
    });
    const snapshot = minimalSnapshot({
      acceptedQuests: [],
      pendingQuests: [{ title: 'Goblin Menace', canTurnIn: false, tab: 'pending' }],
    });
    const allowed = ['market_sell_half', 'quest_talk_accept', 'idle'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.equal(filtered[0], 'quest_talk_accept');
    assert.ok(filtered.indexOf('quest_talk_accept') < filtered.indexOf('market_sell_half'));
  });

  it('when only sell_* in allowed set, sell still sorted first (no quests)', () => {
    const playbook = sellHalfPlaybook();
    const snapshot = minimalSnapshot({
      acceptedQuests: [],
      pendingQuests: [],
    });
    const allowed = ['idle', 'market_sell_half', 'sell_junk_for_gold'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.equal(filtered[0], 'sell_junk_for_gold');
    assert.ok(filtered.indexOf('sell_junk_for_gold') < filtered.indexOf('market_sell_half'));
  });

  it('evaluatePlaybook advances past sell_half to buy_bait when gold >= 2 without sells (seed state at sell_half)', () => {
    statePath = join('/tmp', `playbook-missions-skip-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'sell_half',
        counts: { ...coalMetCounts(), sells: 0 },
        baitOwned: false,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        gold: 2,
        inventory: { 'Coal Ore': 100 },
        flags: {
          hasBait: false,
          bankNearby: false,
          gatherBusy: false,
          inBattle: false,
          sessionValid: true,
        },
      }),
    );

    assert.equal(progress.stage, 'buy_bait');
    assert.equal(progress.counts.sells, 0);
  });
});


describe('batch leveling playbook targets', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('defaults to 100/100/100/120 targets and loops to mine_coal after hunt (pets not required)', () => {
    for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
    const dir = join(getLogDir(), `pb-batch-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.AUTOPILOT_LOG_DIR = dir;
    process.env.PLAYBOOK_STATE_PATH = join(dir, 'playbook-state.json');
    process.env.EARLY_PLAYBOOK = 'true';
    delete process.env.PLAYBOOK_COAL_TARGET;
    delete process.env.PLAYBOOK_FISH_TARGET;
    delete process.env.PLAYBOOK_COOK_TARGET;
    delete process.env.PLAYBOOK_HUNT_TARGET;

    writeFileSync(
      process.env.PLAYBOOK_STATE_PATH,
      JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          coal: 100,
          rawCod: 100,
          cookedCod: 100,
          sells: 2,
          huntBattles: 120,
          mapPeeks: 1,
          petManages: 0,
          batchCycles: 1,
          coalBusyCycles: 300,
          codBusyCycles: 300,
        },
        baitOwned: true,
      }),
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 5, 'Coal Ore': 0, Cod: 0, 'Cooked Cod': 0 },
        gold: 50,
      }),
    );
    assert.equal(progress.targets.coalMin, 100);
    assert.equal(progress.targets.codMin, 100);
    assert.equal(progress.targets.cookMin, 100);
    assert.equal(progress.targets.huntMin, 120);
    assert.equal(progress.complete, false);
    assert.equal(progress.stage, 'mine_coal');
    assert.ok(progress.counts.batchCycles >= 2);
    // Pets not required: petManages can stay 0 across the loop.
    assert.equal(progress.counts.petManages, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});


describe('bait restock preference', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('hard-prefers buy_bait and drops fish_cod when Cheap Bait is low on fish_cod', () => {
    for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
    const dir = join(getLogDir(), `pb-bait-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.AUTOPILOT_LOG_DIR = dir;
    process.env.PLAYBOOK_STATE_PATH = join(dir, 'playbook-state.json');
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      process.env.PLAYBOOK_STATE_PATH,
      JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: coalMetCounts(),
        baitOwned: true,
      }),
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 1, 'Coal Ore': 100 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    });
    const playbook = evaluatePlaybook(snapshot);
    assert.equal(playbook.stage, 'fish_cod');
    assert.equal(playbook.preferredActions[0], 'buy_bait');
    const filtered = filterAllowedByPlaybook(
      ['fish_cod', 'buy_bait', 'craft_if_ready', 'idle'],
      snapshot,
      playbook,
    );
    assert.equal(filtered[0], 'buy_bait');
    assert.ok(!filtered.includes('fish_cod'));
    assert.ok(!filtered.includes('craft_if_ready'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not hard-prefer buy_bait after recent purchase when scrape undercounts', () => {
    for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
    const dir = join(getLogDir(), `pb-bait-trust-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.AUTOPILOT_LOG_DIR = dir;
    process.env.PLAYBOOK_STATE_PATH = join(dir, 'playbook-state.json');
    process.env.EARLY_PLAYBOOK = 'true';
    const purchasedAt = new Date().toISOString();
    writeFileSync(
      process.env.PLAYBOOK_STATE_PATH,
      JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: coalMetCounts(),
        baitOwned: true,
        lastBaitPurchaseAt: purchasedAt,
      }),
    );

    const snapshot = minimalSnapshot({
      // Undercount / icon-only scrape after successful buy_bait
      inventory: { 'Cheap Bait': 0, 'Coal Ore': 100 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    });
    const playbook = evaluatePlaybook(snapshot);
    assert.equal(playbook.stage, 'fish_cod');
    assert.equal(playbook.baitOwned, true);
    assert.ok(recentBaitPurchase(playbook.lastBaitPurchaseAt));
    assert.equal(shouldPreferBaitRestock('fish_cod', 0, purchasedAt), false);
    assert.ok(
      playbook.preferredActions[0] !== 'buy_bait',
      `expected not to hard-prefer buy_bait, got ${playbook.preferredActions.join(',')}`,
    );
    assert.ok(
      !playbook.preferredActions.includes('buy_bait') || playbook.preferredActions[0] === 'fish_cod',
      `buy_bait must not lead preferred after recent purchase: ${playbook.preferredActions.join(',')}`,
    );
    assert.ok(
      playbook.curriculumHint.includes('cooldown') || playbook.curriculumHint.includes('trust'),
      `hint should mention trust/cooldown, got: ${playbook.curriculumHint}`,
    );
    const filtered = filterAllowedByPlaybook(
      ['fish_cod', 'buy_bait', 'craft_if_ready', 'idle'],
      snapshot,
      playbook,
    );
    assert.ok(!filtered.includes('buy_bait'), `buy_bait should be stripped during cooldown, got ${filtered.join(',')}`);
    assert.ok(filtered.includes('fish_cod'), `fish_cod should remain allowed, got ${filtered.join(',')}`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('still prefers buy_bait on fish_cod when scrape <15 and no recent purchase', () => {
    for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
    const dir = join(getLogDir(), `pb-bait-first-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.AUTOPILOT_LOG_DIR = dir;
    process.env.PLAYBOOK_STATE_PATH = join(dir, 'playbook-state.json');
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      process.env.PLAYBOOK_STATE_PATH,
      JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: coalMetCounts(),
        baitOwned: true,
        // expired purchase — cooldown gone
        lastBaitPurchaseAt: new Date(Date.now() - 16 * 60_000).toISOString(),
      }),
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 1, 'Coal Ore': 100 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    });
    const playbook = evaluatePlaybook(snapshot);
    assert.equal(shouldPreferBaitRestock('fish_cod', 1, playbook.lastBaitPurchaseAt), true);
    assert.equal(playbook.preferredActions[0], 'buy_bait');
    const filtered = filterAllowedByPlaybook(
      ['fish_cod', 'buy_bait', 'idle'],
      snapshot,
      playbook,
    );
    assert.equal(filtered[0], 'buy_bait');
    rmSync(dir, { recursive: true, force: true });
  });

  it('shouldPreferBaitRestock allows first restock when empty and no purchase timestamp', () => {
    assert.equal(shouldPreferBaitRestock('fish_cod', 0, undefined), true);
    assert.equal(shouldPreferBaitRestock('fish_cod', 14, undefined), true);
    assert.equal(shouldPreferBaitRestock('fish_cod', 15, undefined), false);
    assert.equal(shouldPreferBaitRestock('mine_coal', 0, undefined), false);
    assert.equal(shouldPreferBaitRestock('fish_cod', 0, new Date().toISOString()), false);
  });
});


describe('coal before fish gate', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath = '';

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  it('snaps stuck fish_cod with low coal back to mine_coal', () => {
    statePath = join('/tmp', `playbook-coal-snap-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: { ...emptyPlaybookCounts(), coal: 4, coalBusyCycles: 8 },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 4 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    });
    const progress = evaluatePlaybook(snapshot);

    assert.equal(progress.stage, 'mine_coal');
    assert.equal(coalTargetMet(progress.counts), false);
    assert.ok(
      progress.curriculumHint.includes('coal gate') || progress.curriculumHint.includes('snapped'),
      `hint should mention coal snap-back, got: ${progress.curriculumHint}`,
    );
    assert.ok(progress.preferredActions.includes('mine_coal'));
    assert.ok(progress.deprioritizedActions.includes('fish_cod'));

    const filtered = filterAllowedByPlaybook(
      ['fish_cod', 'mine_coal', 'cook_cod', 'idle', 'continue_current'],
      snapshot,
      progress,
    );
    assert.equal(filtered[0], 'mine_coal');
    assert.ok(!filtered.includes('fish_cod'));
    assert.ok(!filtered.includes('cook_cod'));

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { stage?: string };
    assert.equal(saved.stage, 'mine_coal');
  });

  it('snaps cook_cod / later stages back to mine_coal when coal still low', () => {
    statePath = join('/tmp', `playbook-coal-snap-later-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'cook_cod',
        counts: { ...emptyPlaybookCounts(), coal: 1, rawCod: 20, coalBusyCycles: 2 },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 5, 'Coal Ore': 1, Cod: 20 },
        gold: 50,
      }),
    );
    assert.equal(progress.stage, 'mine_coal');
  });

  it('allows fish_cod once coal target is met', () => {
    statePath = join('/tmp', `playbook-coal-met-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: coalMetCounts({ sells: 1 }),
        baitOwned: true,
        lastBaitPurchaseAt: new Date().toISOString(),
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 100 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    });
    const progress = evaluatePlaybook(snapshot);

    assert.equal(progress.stage, 'fish_cod');
    assert.equal(coalTargetMet(progress.counts), true);
    assert.ok(progress.preferredActions.includes('fish_cod'));
    assert.ok(!progress.curriculumHint.includes('coal gate'));

    const filtered = filterAllowedByPlaybook(
      ['fish_cod', 'mine_coal', 'idle', 'continue_current'],
      snapshot,
      progress,
    );
    assert.ok(filtered.includes('fish_cod'));
  });

  it('notePlaybookOutcome buy_bait stays on mine_coal when coal incomplete', () => {
    statePath = join('/tmp', `playbook-coal-buy-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'buy_bait',
        counts: { ...emptyPlaybookCounts(), coal: 3 },
        baitOwned: false,
      })}\n`,
    );

    notePlaybookOutcome('buy_bait', 'purchased');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      stage?: string;
      baitOwned?: boolean;
      lastBaitPurchaseAt?: string;
    };
    assert.equal(saved.baitOwned, true);
    assert.ok(saved.lastBaitPurchaseAt);
    assert.equal(saved.stage, 'mine_coal');
  });

  it('reports default coalMin 100 matching PLAYBOOK_COAL_TARGET default', () => {
    statePath = join('/tmp', `playbook-coal-target-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    delete process.env.PLAYBOOK_COAL_TARGET;
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'mine_coal',
        counts: emptyPlaybookCounts(),
        baitOwned: false,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Coal Ore': 2 },
        flags: {
          hasBait: false,
          bankNearby: false,
          gatherBusy: false,
          inBattle: false,
          sessionValid: true,
        },
      }),
    );
    assert.equal(progress.targets.coalMin, 100);
    assert.equal(progress.stage, 'mine_coal');
  });
  it('does NOT treat high coalBusyCycles alone as coal target met (Bocchi snap-back)', () => {
    statePath = join('/tmp', `playbook-coal-busy-only-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: { ...emptyPlaybookCounts(), coal: 4, coalBusyCycles: 552 },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 4 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    });
    const progress = evaluatePlaybook(snapshot);

    assert.equal(coalTargetMet(progress.counts), false);
    assert.equal(progress.stage, 'mine_coal');
    assert.ok(
      progress.curriculumHint.includes('coal gate') || progress.curriculumHint.includes('snapped'),
      `hint should mention coal snap-back, got: ${progress.curriculumHint}`,
    );

    const filtered = filterAllowedByPlaybook(
      ['fish_cod', 'mine_coal', 'cook_cod', 'hunt_battle', 'idle'],
      snapshot,
      progress,
    );
    assert.equal(filtered[0], 'mine_coal');
    assert.ok(!filtered.includes('fish_cod'));
  });

  it('syncs inventory Coal Ore into counts for the hard coal gate', () => {
    statePath = join('/tmp', `playbook-coal-inv-sync-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'mine_coal',
        counts: emptyPlaybookCounts(),
        baitOwned: false,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Coal Ore': 100 },
        gold: 50,
        flags: {
          hasBait: false,
          bankNearby: false,
          gatherBusy: false,
          inBattle: false,
          sessionValid: true,
        },
      }),
    );
    assert.ok(progress.counts.coal >= 100);
    assert.equal(coalTargetMet(progress.counts), true);
    assert.notEqual(progress.stage, 'mine_coal');
  });
});

describe('strict sequential real-count gates', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath = '';

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  it('does NOT advance fish_cod via codBusyCycles alone', () => {
    statePath = join('/tmp', `playbook-fish-busy-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: { ...coalMetCounts({ sells: 1 }), rawCod: 10, codBusyCycles: 500 },
        baitOwned: true,
        lastBaitPurchaseAt: new Date().toISOString(),
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 10 },
        gold: 50,
      }),
    );
    assert.equal(fishTargetMet(progress.counts), false);
    assert.equal(progress.stage, 'fish_cod');
  });

  it('snaps cook_cod back to fish_cod when rawCod below target', () => {
    statePath = join('/tmp', `playbook-fish-snap-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'cook_cod',
        counts: { ...coalMetCounts({ sells: 1 }), rawCod: 12, cookedCod: 5, codBusyCycles: 400 },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 12, 'Cooked Cod': 5 },
        gold: 50,
      }),
    );
    assert.equal(progress.stage, 'fish_cod');
    assert.ok(
      progress.curriculumHint.includes('fish gate') || progress.curriculumHint.includes('snapped'),
      `hint: ${progress.curriculumHint}`,
    );
  });

  it('snaps hunt_rabbits back to cook_cod when cookedCod below target', () => {
    statePath = join('/tmp', `playbook-cook-snap-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 8,
          huntBattles: 3,
        },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 100, 'Cooked Cod': 8 },
        gold: 50,
      }),
    );
    assert.equal(cookTargetMet(progress.counts), false);
    assert.equal(progress.stage, 'cook_cod');
    assert.ok(progress.curriculumHint.includes('cook gate'), progress.curriculumHint);
  });

  it('cooks before hunt when the cook target is met but inventory has no food', () => {
    statePath = join('/tmp', `playbook-no-food-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 4,
        },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 40, Cod: 12, 'Cooked Cod': 0 },
      gold: 50,
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.stage, 'hunt_battle_batch');
    const filtered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'cook_cod', 'idle'],
      snapshot,
      progress,
    );
    assert.ok(!filtered.includes('hunt_battle_batch'));
    assert.ok(!filtered.includes('hunt_battle'));
    assert.ok(filtered.includes('cook_cod'));
  });

  it('cooks before hunt when Cooked Cod is under the target, and hunts once it matches', () => {
    statePath = join('/tmp', `playbook-food-threshold-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 4,
        },
        baitOwned: true,
      })}\n`,
    );

    const short = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 40, Cod: 12, 'Cooked Cod': 40 },
      gold: 50,
    });
    const shortProgress = evaluatePlaybook(short);
    const shortFiltered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'cook_cod', 'idle'],
      short,
      shortProgress,
    );
    assert.ok(!shortFiltered.includes('hunt_battle_batch'));
    assert.ok(shortFiltered.includes('cook_cod'));

    const ready = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 40, Cod: 12, 'Cooked Cod': 100 },
      gold: 50,
    });
    const readyProgress = evaluatePlaybook(ready);
    const readyFiltered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'idle'],
      ready,
      readyProgress,
    );
    assert.ok(readyFiltered.includes('hunt_battle_batch'));
    assert.ok(!readyFiltered.includes('cook_cod'));
  });

  it('snaps hunt back to cook when soft cookedCod is inflated but the bag is short', () => {
    statePath = join('/tmp', `playbook-cooked-drift-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 200,
          cookedCod: 146,
          huntBattles: 26,
        },
        baitOwned: true,
      })}\n`,
    );

    // IdleBocchi-like: restarts inflated soft cookedCod, bag still under cookMin.
    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 80, Cod: 40, 'Cooked Cod': 43 },
      gold: 50,
      combatPhase: 'none',
      currentAction: {
        busy: true,
        skill: 'cooking',
        resource: 'Cooked Cod',
        producedCount: 146,
      },
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.counts.cookedCod, 43);
    assert.equal(cookTargetMet(progress.counts, snapshot.inventory), false);
    assert.equal(progress.stage, 'cook_cod');
    assert.ok(progress.curriculumHint.includes('cook gate'), progress.curriculumHint);
    assert.equal(progress.preferredActions[0], 'cook_cod');
    const filtered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'hunt_rabbits', 'cook_cod', 'quest_talk_accept', 'idle'],
      snapshot,
      progress,
    );
    assert.ok(!filtered.includes('hunt_battle_batch'), `filtered=${JSON.stringify(filtered)}`);
    assert.ok(!filtered.includes('hunt_battle'), `filtered=${JSON.stringify(filtered)}`);
    assert.ok(!filtered.includes('hunt_rabbits'), `filtered=${JSON.stringify(filtered)}`);
    assert.equal(filtered[0], 'cook_cod', `filtered=${JSON.stringify(filtered)}`);
  });

  it('allows hunt when soft cookedCod is high and bag Cooked Cod meets cookMin', () => {
    statePath = join('/tmp', `playbook-cooked-bag-met-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 200,
          cookedCod: 146,
          huntBattles: 26,
        },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 80, Cod: 40, 'Cooked Cod': 112 },
      gold: 50,
      combatPhase: 'none',
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.counts.cookedCod, 112);
    assert.equal(cookTargetMet(progress.counts, snapshot.inventory), true);
    assert.equal(progress.stage, 'hunt_battle_batch');
    const filtered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'cook_cod', 'idle'],
      snapshot,
      progress,
    );
    assert.equal(filtered[0], 'hunt_battle_batch', `filtered=${JSON.stringify(filtered)}`);
    assert.ok(filtered.includes('hunt_battle'), `filtered=${JSON.stringify(filtered)}`);
    const cookIdx = filtered.indexOf('cook_cod');
    assert.ok(cookIdx === -1 || cookIdx > filtered.indexOf('hunt_battle_batch'));
  });

  it('does not bump cookedCod when cook_cod restarts and the bag is unchanged', () => {
    statePath = join('/tmp', `playbook-cook-restart-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'cook_cod',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 200,
          cookedCod: 43,
          huntBattles: 4,
        },
        baitOwned: true,
      })}\n`,
    );

    for (const outcome of ['restarted', 'already_busy', 'kept_current']) {
      notePlaybookOutcome('cook_cod', outcome);
    }
    const afterRestart = JSON.parse(readFileSync(statePath, 'utf8')) as {
      counts?: { cookedCod?: number };
    };
    assert.equal(afterRestart.counts?.cookedCod, 43);

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 80, Cod: 40, 'Cooked Cod': 43 },
      gold: 50,
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.counts.cookedCod, 43);
    assert.equal(progress.stage, 'cook_cod');
  });

  it('credits cooking producedCount only when the bag omits Cooked Cod', () => {
    statePath = join('/tmp', `playbook-cook-produced-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'cook_cod',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 200,
          cookedCod: 10,
          huntBattles: 0,
        },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 80, Cod: 40, 'Cooked Cod': 0 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: true,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: {
        busy: true,
        skill: 'cooking',
        resource: 'Cooked Cod',
        producedCount: 25,
      },
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.counts.cookedCod, 25);
    assert.equal(cookTargetMet(progress.counts, snapshot.inventory), false);
    assert.equal(progress.stage, 'cook_cod');
  });

  it('hard-prefers cook_cod over quest_talk_accept when cook-before-hunt', () => {
    statePath = join('/tmp', `playbook-cook-prefer-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 287,
          cookedCod: 101,
          huntBattles: 26,
        },
        baitOwned: true,
      })}\n`,
    );

    // HitoriIdle-like: cook target met in counts, but bag has no Cooked Cod.
    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 8, 'Coal Ore': 4500, 'Raw Cod': 287 },
      gold: 110,
      combatPhase: 'none',
      pendingQuests: [{ title: 'A Rabbits Fortune', progress: '1 / 40', canTurnIn: false, tab: 'pending' }],
    });
    const progress = evaluatePlaybook(snapshot);
    assert.ok(progress.preferredActions[0] === 'cook_cod', `preferred=${JSON.stringify(progress.preferredActions)}`);
    const filtered = filterAllowedByPlaybook(
      ['quest_talk_accept', 'idle', 'fish_cod', 'cook_cod', 'craft_if_ready', 'explore_map', 'sell_junk', 'sell_junk_for_gold'],
      snapshot,
      progress,
    );
    assert.equal(filtered[0], 'cook_cod', `filtered=${JSON.stringify(filtered)}`);
    assert.ok(filtered.includes('quest_talk_accept'));
    assert.ok(!filtered.includes('hunt_battle_batch'));
  });

  it('hides legacy hunt_rabbits alias when cook-before-hunt (no active hunt)', () => {
    statePath = join('/tmp', `playbook-alias-cook-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 4,
        },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 50, 'Cooked Cod': 17 },
      gold: 110,
      combatPhase: 'none',
    });
    const progress = evaluatePlaybook(snapshot);
    const filtered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_rabbits', 'hunt_battle', 'cook_cod', 'idle'],
      snapshot,
      progress,
    );
    assert.ok(!filtered.includes('hunt_battle_batch'), `filtered=${JSON.stringify(filtered)}`);
    assert.ok(!filtered.includes('hunt_rabbits'), `legacy alias leaked: ${JSON.stringify(filtered)}`);
    assert.ok(!filtered.includes('hunt_battle'), `filtered=${JSON.stringify(filtered)}`);
    assert.ok(filtered.includes('cook_cod'), `filtered=${JSON.stringify(filtered)}`);
  });

  it('keeps hunt_rabbits when cook-before-hunt but an active hunt must finish', () => {
    statePath = join('/tmp', `playbook-orphan-hunt-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 4,
        },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 40, Cod: 12, 'Cooked Cod': 17 },
      gold: 110,
      combatPhase: 'hunt',
      totalEnemiesFound: 239,
      currentAction: { busy: true, label: 'combat:hunt' },
      flags: {
        hasBait: true,
        bankNearby: true,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
    });
    const progress = evaluatePlaybook(snapshot);
    const filtered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'cook_cod', 'quest_talk_accept', 'idle'],
      snapshot,
      progress,
    );
    assert.ok(filtered.includes('hunt_battle_batch'), `filtered=${JSON.stringify(filtered)}`);
    assert.ok(!filtered.includes('cook_cod'), `cook should wait: ${JSON.stringify(filtered)}`);
  });

  it('keeps hunt_rabbits when found is over cap even if combatPhase is none', () => {
    statePath = join('/tmp', `playbook-overcap-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'cook_cod',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 80,
          huntBattles: 2,
        },
        baitOwned: true,
      })}\n`,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 40, Cod: 50, 'Cooked Cod': 17 },
      gold: 110,
      combatPhase: 'none',
      totalEnemiesFound: 239,
    });
    const progress = evaluatePlaybook(snapshot);
    const filtered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'cook_cod', 'idle'],
      snapshot,
      progress,
    );
    assert.ok(filtered.includes('hunt_battle_batch'), `filtered=${JSON.stringify(filtered)}`);
    assert.ok(!filtered.includes('cook_cod'));
  });

  it('migrates persisted hunt_rabbits + rabbitHunts on load', () => {
    statePath = join('/tmp', `playbook-migrate-hunt-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_rabbits',
        counts: {
          coal: 100,
          rawCod: 100,
          cookedCod: 100,
          sells: 2,
          rabbitHunts: 17,
          mapPeeks: 0,
          petManages: 0,
          batchCycles: 0,
          coalBusyCycles: 0,
          codBusyCycles: 0,
        },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 100, 'Cooked Cod': 100 },
        gold: 50,
      }),
    );
    assert.equal(normalizeEarlyStageId('hunt_rabbits'), 'hunt_battle_batch');
    assert.equal(progress.stage, 'hunt_battle_batch');
    assert.equal(progress.counts.huntBattles, 17);
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      stage?: string;
      counts?: { huntBattles?: number; rabbitHunts?: number };
    };
    assert.equal(saved.stage, 'hunt_battle_batch');
    assert.equal(saved.counts?.huntBattles, 17);
  });

  it('simulates battle-now when Total Enemies Found >= 100 (live 239 case)', async () => {
    // Offline recreation of today's live path: found climbed past cap while cook was short.
    // Cap must hard-stop, and playbook must keep combat allowed so bootstrap can battle now.
    const prevCap = process.env.HUNT_FOUND_CAP;
    process.env.HUNT_FOUND_CAP = '100';
    statePath = join('/tmp', `playbook-battle-now-sim-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 17,
          huntBattles: 4,
        },
        baitOwned: true,
      })}\n`,
    );

    const { shouldHardStopHunt } = await import('../deterministic/hunt-cap.js');
    const { isHuntHardStop } = await import('../jev/hunt-cap.js');
    assert.equal(shouldHardStopHunt(239, 12, 80), true);
    assert.equal(
      isHuntHardStop({
        totalEnemiesFound: 239,
        enemies: [],
        defeatedCount: 0,
        pageText: '',
        combatLevel: 12,
        totalLevel: 80,
      }),
      true,
    );

    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 50, 'Cooked Cod': 17 },
      gold: 110,
      combatPhase: 'hunt',
      totalEnemiesFound: 239,
      enemiesRemaining: 713,
      combatLevel: 12,
      totalLevel: 80,
    });
    const progress = evaluatePlaybook(snapshot);
    const filtered = filterAllowedByPlaybook(
      ['hunt_battle_batch', 'hunt_battle', 'cook_cod', 'quest_talk_accept', 'idle'],
      snapshot,
      progress,
    );
    assert.ok(
      filtered.includes('hunt_battle_batch'),
      `battle-now sim must keep hunt_battle_batch; filtered=${JSON.stringify(filtered)} stage=${progress.stage}`,
    );
    assert.ok(!filtered.includes('cook_cod'), `cook must wait while over-cap hunt finishes: ${JSON.stringify(filtered)}`);

    if (prevCap === undefined) delete process.env.HUNT_FOUND_CAP;
    else process.env.HUNT_FOUND_CAP = prevCap;
  });

  it('snaps manage_pets back to hunt_rabbits when rabbitHunts below target', () => {
    statePath = join('/tmp', `playbook-hunt-snap-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'manage_pets',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 40,
          petManages: 0,
        },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 100, 'Cooked Cod': 100 },
        gold: 50,
      }),
    );
    assert.equal(huntTargetMet(progress.counts), false);
    assert.equal(progress.stage, 'hunt_battle_batch');
    assert.equal(progress.targets.huntMin, 120);
    assert.ok(progress.curriculumHint.includes('hunt gate'), progress.curriculumHint);
  });

  it('advances fish→cook→hunt only when real counts meet targets', () => {
    statePath = join('/tmp', `playbook-seq-advance-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 120,
        },
        baitOwned: true,
        lastBaitPurchaseAt: new Date().toISOString(),
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 100, 'Cooked Cod': 100 },
        gold: 50,
      }),
    );
    assert.equal(coalTargetMet(progress.counts), true);
    assert.equal(fishTargetMet(progress.counts), true);
    assert.equal(cookTargetMet(progress.counts), true);
    assert.equal(huntTargetMet(progress.counts), true);
    // Hunt met → explore_map on first cycle (batchCycles=0, mapPeeks=0) — not manage_pets.
    assert.equal(progress.stage, 'explore_map');
    assert.notEqual(progress.stage, 'manage_pets');
  });
});

describe('async opportunistic pets', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath = '';

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  it('hunt met loops to mine_coal without requiring petManages>=1', () => {
    statePath = join('/tmp', `playbook-pets-async-loop-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 120,
          mapPeeks: 1,
          petManages: 0,
          batchCycles: 2,
        },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 0, Cod: 0, 'Cooked Cod': 0 },
        gold: 50,
      }),
    );
    assert.equal(progress.stage, 'mine_coal');
    assert.ok(progress.counts.batchCycles >= 3);
    assert.equal(progress.counts.petManages, 0);
  });

  it('soft-prefers manage_pets interrupt when idle on every Nth cycle', () => {
    statePath = join('/tmp', `playbook-pets-async-prefer-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'mine_coal',
        counts: {
          ...emptyPlaybookCounts(),
          coal: 10,
          petManages: 0,
          batchCycles: 0,
        },
        baitOwned: true,
      })}\n`,
    );

    const idleSnap = minimalSnapshot({
      inventory: { 'Cheap Bait': 5, 'Coal Ore': 10 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: { busy: false },
    });
    assert.equal(shouldInjectAsyncPets(emptyPlaybookCounts(), idleSnap), true);

    const progress = evaluatePlaybook(idleSnap);
    assert.equal(progress.stage, 'mine_coal');
    assert.ok(
      progress.preferredActions.includes('manage_pets'),
      `expected manage_pets soft prefer, got ${progress.preferredActions.join(',')}`,
    );
    assert.ok(progress.interruptActions.includes('manage_pets'));
    assert.ok(progress.curriculumHint.includes('pets async'));

    const filtered = filterAllowedByPlaybook(
      ['mine_coal', 'manage_pets', 'idle', 'continue_current'],
      idleSnap,
      progress,
    );
    assert.ok(filtered.includes('manage_pets'));
    assert.equal(filtered[0], 'mine_coal'); // hard gate still leads
  });

  it('injects async pets maintenance while gatherBusy', () => {
    statePath = join('/tmp', `playbook-pets-async-busy-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'mine_coal',
        counts: {
          ...emptyPlaybookCounts(),
          coal: 10,
          petManages: 0,
          batchCycles: 0,
        },
        baitOwned: true,
      })}\n`,
    );

    const busySnap = minimalSnapshot({
      inventory: { 'Cheap Bait': 5, 'Coal Ore': 10 },
      gold: 50,
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: true,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: { busy: true, skill: 'mining', resource: 'Coal Ore' },
    });
    assert.equal(shouldInjectAsyncPets(emptyPlaybookCounts(), busySnap), true);

    const progress = evaluatePlaybook(busySnap);
    assert.ok(
      progress.preferredActions.includes('manage_pets'),
      `expected manage_pets while busy, got ${progress.preferredActions.join(',')}`,
    );
    assert.equal(progress.preferredActions[0], 'manage_pets');
    assert.ok(progress.interruptActions.includes('manage_pets'));
    assert.ok(
      !progress.preferredActions.includes('equip_pet'),
      'equip_pet must not inject while busy',
    );

    const filtered = filterAllowedByPlaybook(
      ['mine_coal', 'manage_pets', 'idle', 'continue_current'],
      busySnap,
      progress,
    );
    assert.ok(filtered.includes('manage_pets'));
  });

  it('injects equip_pet only when idle after one maintain tick', () => {
    const idleSnap = minimalSnapshot({
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: { busy: false },
    });
    const afterMaintain = { ...emptyPlaybookCounts(), petManages: 1 };
    assert.equal(shouldInjectEquipPet(afterMaintain, idleSnap), true);
    assert.equal(shouldInjectAsyncPets(afterMaintain, idleSnap), false);

    const busySnap = minimalSnapshot({
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: true,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: { busy: true, skill: 'mining', resource: 'Coal Ore' },
    });
    assert.equal(shouldInjectEquipPet(afterMaintain, busySnap), false);
    assert.equal(shouldInjectEquipPet(emptyPlaybookCounts(), idleSnap), false);
    assert.equal(
      shouldInjectEquipPet({ ...emptyPlaybookCounts(), petManages: 2 }, idleSnap),
      false,
    );
  });

  it('legacy manage_pets persisted stage does not block loop after hunt met', () => {
    statePath = join('/tmp', `playbook-pets-legacy-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'manage_pets',
        counts: {
          ...coalMetCounts({ sells: 2 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 120,
          mapPeeks: 1,
          petManages: 0,
          batchCycles: 1,
        },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 5, 'Coal Ore': 0 },
        gold: 50,
      }),
    );
    assert.equal(progress.stage, 'mine_coal');
    assert.ok(progress.counts.batchCycles >= 2);
  });
});

describe('skip sell_extras after cook', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath = '';

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  it('advances to hunt_rabbits when cook target met and hunts unmet (skips sell_extras)', () => {
    statePath = join('/tmp', `playbook-skip-sell-extras-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'cook_cod',
        counts: {
          ...coalMetCounts({ sells: 1 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 0,
        },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 100, 'Cooked Cod': 100 },
        gold: 50,
      }),
    );

    assert.equal(cookTargetMet(progress.counts), true);
    assert.equal(huntTargetMet(progress.counts), false);
    assert.equal(progress.stage, 'hunt_battle_batch');
    assert.notEqual(progress.stage, 'sell_extras');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { stage?: string };
    assert.equal(saved.stage, 'hunt_battle_batch');
  });

  it('normalizes persisted sell_extras to hunt_rabbits when cook met without sells >= 2', () => {
    statePath = join('/tmp', `playbook-legacy-sell-extras-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'sell_extras',
        counts: {
          ...coalMetCounts({ sells: 1 }),
          rawCod: 100,
          cookedCod: 100,
          huntBattles: 5,
        },
        baitOwned: true,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 20, 'Coal Ore': 100, Cod: 100, 'Cooked Cod': 100 },
        gold: 50,
      }),
    );

    assert.equal(cookTargetMet(progress.counts), true);
    assert.equal(huntTargetMet(progress.counts), false);
    assert.equal(progress.counts.sells, 1);
    assert.equal(progress.stage, 'hunt_battle_batch');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { stage?: string };
    assert.equal(saved.stage, 'hunt_battle_batch');
  });
});

describe('stale coal gather', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath: string;

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  it('updateStaleCoalBusyTracking flips stale after flat busy cycles', () => {
    let track = updateStaleCoalBusyTracking({}, 3, true);
    assert.equal(track.stale, false);
    assert.equal(track.staleCoalBusyCycles, 1);
    for (let i = 0; i < STALE_COAL_BUSY_CYCLES - 1; i++) {
      track = updateStaleCoalBusyTracking(track, 3, true);
    }
    assert.equal(track.stale, true);
    assert.ok(track.staleCoalBusyCycles >= STALE_COAL_BUSY_CYCLES);
  });

  it('updateStaleCoalBusyTracking resets when coal inventory rises', () => {
    let track = updateStaleCoalBusyTracking({ lastCoalProgressSeen: 3, staleCoalBusyCycles: 5 }, 3, true);
    assert.equal(track.staleCoalBusyCycles, 6);
    track = updateStaleCoalBusyTracking(track, 8, true);
    assert.equal(track.stale, false);
    assert.equal(track.staleCoalBusyCycles, 0);
    assert.equal(track.lastCoalProgressSeen, 8);
  });

  it('updateStaleCoalBusyTracking resets when not busy mining coal', () => {
    const track = updateStaleCoalBusyTracking(
      { lastCoalProgressSeen: 3, staleCoalBusyCycles: 9 },
      3,
      false,
    );
    assert.equal(track.stale, false);
    assert.equal(track.staleCoalBusyCycles, 0);
  });

  it('filterAllowedByPlaybook drops continue_current when staleCoalGather', () => {
    const playbook = fishCodPlaybook({
      stage: 'mine_coal',
      stageIndex: 0,
      stageGoal: 'Mine coal',
      preferredActions: ['mine_coal', 'continue_current'],
      interruptActions: ['mine_coal'],
      deprioritizedActions: ['gather_oak', 'gather_yew', 'fish_cod'],
      counts: { ...emptyPlaybookCounts(), coal: 3, coalBusyCycles: 40 },
      staleCoalGather: true,
      staleCoalBusyCycles: STALE_COAL_BUSY_CYCLES,
      gatherGraceActive: false,
    });
    const snapshot = minimalSnapshot({
      inventory: { 'Coal Ore': 1 },
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: true,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: { busy: true, skill: 'mining', resource: 'Coal Ore' },
    });
    const filtered = filterAllowedByPlaybook(
      ['mine_coal', 'continue_current', 'idle', 'craft_if_ready'],
      snapshot,
      playbook,
    );
    assert.ok(!filtered.includes('continue_current'), `got ${filtered.join(',')}`);
    assert.equal(filtered[0], 'mine_coal');
  });

  it('evaluatePlaybook marks staleCoalGather after enough flat busy ticks', () => {
    statePath = join('/tmp', `playbook-stale-coal-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'mine_coal',
        counts: { ...emptyPlaybookCounts(), coal: 3, coalBusyCycles: 20 },
        baitOwned: true,
        lastCoalProgressSeen: 3,
        staleCoalBusyCycles: STALE_COAL_BUSY_CYCLES - 1,
      })}\n`,
    );

    const snap = minimalSnapshot({
      inventory: { 'Coal Ore': 1, 'Cheap Bait': 5 },
      flags: {
        hasBait: true,
        bankNearby: false,
        gatherBusy: true,
        inBattle: false,
        sessionValid: true,
      },
      currentAction: { busy: true, skill: 'mining', resource: 'Coal Ore' },
    });
    const progress = evaluatePlaybook(snap);
    assert.equal(progress.stage, 'mine_coal');
    assert.equal(progress.staleCoalGather, true);
    assert.ok(progress.staleCoalBusyCycles >= STALE_COAL_BUSY_CYCLES);
    assert.ok(progress.preferredActions.includes('mine_coal'));
    assert.ok(!progress.preferredActions.includes('continue_current'));

    const filtered = filterAllowedByPlaybook(
      ['mine_coal', 'continue_current', 'idle'],
      snap,
      progress,
    );
    assert.ok(!filtered.includes('continue_current'));
    assert.equal(filtered[0], 'mine_coal');
  });

  it('syncs higher Coal Ore inventory into counts (progress reflects real ore)', () => {
    statePath = join('/tmp', `playbook-coal-sync-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'mine_coal',
        counts: { ...emptyPlaybookCounts(), coal: 3 },
        baitOwned: true,
        lastCoalProgressSeen: 3,
        staleCoalBusyCycles: 4,
      })}\n`,
    );

    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Coal Ore': 12 },
        currentAction: { busy: true, skill: 'mining', resource: 'Coal Ore' },
        flags: {
          hasBait: true,
          bankNearby: false,
          gatherBusy: true,
          inBattle: false,
          sessionValid: true,
        },
      }),
    );
    assert.equal(progress.counts.coal, 12);
    assert.equal(progress.staleCoalGather, false);
    assert.equal(progress.staleCoalBusyCycles, 0);
  });

  it('notePlaybookOutcome mine_coal restarted sets gather restart + clears stale cycles', () => {
    statePath = join('/tmp', `playbook-mine-restart-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'mine_coal',
        counts: { ...emptyPlaybookCounts(), coal: 3, coalBusyCycles: 30 },
        baitOwned: true,
        staleCoalBusyCycles: 9,
        lastCoalProgressSeen: 3,
      })}\n`,
    );

    notePlaybookOutcome('mine_coal', 'restarted');
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(saved.lastGatherRestartAt);
    assert.equal(saved.lastGatherSkill, 'mining');
    assert.equal(saved.lastGatherResource, 'Coal Ore');
    assert.equal(saved.staleCoalBusyCycles, 0);
  });
});

describe('post-cook quest talk does not outrank hunt', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath: string;
  const stub = new ProgressiveStubJev();
  const choiceContext: AutopilotContext = { cycle: 4, gatherRotationIndex: 0 };

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  function writeState(stage: string, counts: Record<string, number>, extra: Record<string, unknown> = {}): void {
    statePath = join('/tmp', `playbook-hunt-stall-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, stage, counts, baitOwned: true, ...extra })}\n`,
    );
  }

  function huntReadySnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
    return minimalSnapshot({
      inventory: { 'Cheap Bait': 8, 'Coal Ore': 40, Cod: 20, 'Cooked Cod': 111 },
      gold: 110,
      combatLevel: 2,
      combatPhase: 'none',
      pendingQuests: [
        { title: 'A Rabbits Fortune', progress: '1 / 40', canTurnIn: false, tab: 'pending' },
      ],
      ...overrides,
    });
  }

  function huntCounts(overrides: Record<string, number> = {}) {
    return {
      ...coalMetCounts({ sells: 1 }),
      rawCod: 100,
      cookedCod: 111,
      huntBattles: 41,
      petManages: 1,
      batchCycles: 1,
      ...overrides,
    };
  }

  it('hunt_battle_batch with a pending hard kill quest prefers hunt and chooseNextAction returns it', async () => {
    writeState('hunt_battle_batch', huntCounts());
    const snapshot = huntReadySnapshot();
    const progress = evaluatePlaybook(snapshot, {
      ...choiceContext,
      lastAction: 'quest_talk_accept',
    });

    assert.equal(progress.stage, 'hunt_battle_batch');
    assert.equal(progress.preferredActions[0], 'hunt_battle_batch');
    assert.ok(
      progress.preferredActions.indexOf('quest_talk_accept') >
        progress.preferredActions.indexOf('hunt_battle_batch'),
      `preferred=${JSON.stringify(progress.preferredActions)}`,
    );

    const filtered = filterAllowedByPlaybook(
      ['quest_talk_accept', 'hunt_battle_batch', 'hunt_battle', 'idle'],
      snapshot,
      progress,
    );
    assert.equal(filtered[0], 'hunt_battle_batch', `filtered=${JSON.stringify(filtered)}`);

    const action = await stub.chooseNextAction(
      {
        ...snapshot,
        extensions: {
          earlySystemsPlaybook: progress,
          questCurriculum: progress.questCurriculum,
        },
      },
      ['quest_talk_accept', 'hunt_battle_batch', 'hunt_battle', 'idle'],
      choiceContext,
    );
    assert.equal(action, 'hunt_battle_batch');
  });

  it('keeps quest_turnin first when a hard kill is pending and a quest can turn in', () => {
    writeState('hunt_battle_batch', huntCounts());
    const snapshot = huntReadySnapshot({
      acceptedQuests: [
        { title: 'Wood for the Hearth', progress: '150 / 150', canTurnIn: true, tab: 'accepted' },
      ],
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.preferredActions[0], 'quest_turnin', `preferred=${JSON.stringify(progress.preferredActions)}`);
    assert.ok(
      progress.preferredActions.indexOf('hunt_battle_batch') <
        progress.preferredActions.indexOf('quest_talk_accept'),
      `preferred=${JSON.stringify(progress.preferredActions)}`,
    );
  });

  it('still elevates quest_talk_accept for an easy pending hearth quest', () => {
    writeState('hunt_battle_batch', huntCounts());
    const snapshot = huntReadySnapshot({
      pendingQuests: [
        { title: 'Wood for the Hearth', progress: '12 / 150', canTurnIn: false, tab: 'pending' },
      ],
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(
      progress.preferredActions[0],
      'quest_talk_accept',
      `preferred=${JSON.stringify(progress.preferredActions)}`,
    );
    assert.equal(progress.questCurriculum?.hasEasyFinishableQuest, true);
  });

  it('keeps cook_cod ahead of quest_talk on the cook stage', () => {
    writeState('cook_cod', {
      ...coalMetCounts({ sells: 1 }),
      rawCod: 100,
      cookedCod: 20,
      huntBattles: 0,
      petManages: 1,
      batchCycles: 1,
    });
    const snapshot = minimalSnapshot({
      inventory: { 'Cheap Bait': 8, 'Coal Ore': 40, Cod: 40, 'Cooked Cod': 20 },
      gold: 40,
      combatLevel: 2,
      pendingQuests: [
        { title: 'A Rabbits Fortune', progress: '1 / 40', canTurnIn: false, tab: 'pending' },
      ],
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.stage, 'cook_cod');
    assert.equal(progress.preferredActions[0], 'cook_cod', `preferred=${JSON.stringify(progress.preferredActions)}`);
    assert.ok(
      progress.preferredActions.indexOf('cook_cod') < progress.preferredActions.indexOf('quest_talk_accept'),
    );
  });

  it('still prepends quest_talk_accept on mine_coal when any quest is pending', () => {
    writeState('mine_coal', {
      ...emptyPlaybookCounts(),
      coal: 10,
      petManages: 1,
      batchCycles: 1,
    });
    const snapshot = minimalSnapshot({
      inventory: { 'Coal Ore': 10 },
      gold: 0,
      flags: {
        hasBait: false,
        bankNearby: false,
        gatherBusy: false,
        inBattle: false,
        sessionValid: true,
      },
      pendingQuests: [
        { title: 'A Rabbits Fortune', progress: '0 / 40', canTurnIn: false, tab: 'pending' },
      ],
    });
    const progress = evaluatePlaybook(snapshot);
    assert.equal(progress.stage, 'mine_coal');
    assert.equal(
      progress.preferredActions[0],
      'quest_talk_accept',
      `preferred=${JSON.stringify(progress.preferredActions)}`,
    );
  });

  it('demotes quest_talk for several cycles after talk:no_action', () => {
    writeState('hunt_battle_batch', huntCounts());
    const snapshot = huntReadySnapshot({
      pendingQuests: [
        { title: 'Wood for the Hearth', progress: '150 / 150', canTurnIn: false, tab: 'pending' },
      ],
    });
    const before = evaluatePlaybook(snapshot);
    assert.equal(before.preferredActions[0], 'quest_talk_accept');

    notePlaybookOutcome('quest_talk_accept', 'talk:no_action');
    const stalledContext: AutopilotContext = {
      ...choiceContext,
      lastAction: 'quest_talk_accept',
    };
    for (let i = 0; i < QUEST_TALK_NO_ACTION_COOLDOWN; i++) {
      const progress = evaluatePlaybook(snapshot, stalledContext);
      assert.equal(
        progress.preferredActions[0],
        'hunt_battle_batch',
        `cycle ${i} preferred=${JSON.stringify(progress.preferredActions)}`,
      );
      assert.ok((progress.questTalkNoActionCycles ?? 0) > 0);
    }
    const resumed = evaluatePlaybook(snapshot, stalledContext);
    assert.equal(resumed.preferredActions[0], 'quest_talk_accept');
    assert.equal(resumed.questTalkNoActionCycles ?? 0, 0);
  });

  it('interrupts Coal Ore when the playbook wants hunt, and still honors grace and cook', () => {
    const coal: GatherState = {
      busy: true,
      currentResource: 'Coal Ore',
      skill: 'mining',
      pageText: 'CURRENT ACTION Coal Ore',
    };
    const huntBook: PlaybookProgress = {
      enabled: true,
      stage: 'hunt_battle_batch',
      stageIndex: 5,
      stageGoal: 'hunt',
      preferredActions: ['hunt_battle_batch', 'hunt_battle'],
      deprioritizedActions: [],
      interruptActions: ['mine_coal', 'hunt_battle_batch', 'hunt_battle'],
      counts: emptyPlaybookCounts(),
      baitOwned: true,
      targets: { coalMin: 100, coalMax: 100, codMin: 100, codMax: 100, cookMin: 100, huntMin: 120 },
      curriculumHint: 'hunt',
      complete: false,
      gatherGraceActive: false,
      fishCodBackoffActive: false,
      consecutiveFishCodFailures: 0,
      staleCoalGather: false,
      staleCoalBusyCycles: 0,
    };

    assert.equal(shouldInterruptGatherForPlaybook(huntBook, coal), true);
    assert.equal(
      shouldInterruptGatherForPlaybook(
        { ...huntBook, preferredActions: ['hunt_battle_batch'], interruptActions: ['mine_coal'] },
        coal,
      ),
      true,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(
        { ...huntBook, interruptActions: ['hunt_battle_batch', 'hunt_battle'] },
        { busy: false, busyElsewhere: { skill: 'mining', resource: 'Coal Ore' }, pageText: '' },
      ),
      true,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(huntBook, {
        busy: true,
        currentResource: 'Yew Log',
        skill: 'woodcutting',
        pageText: '',
      }),
      true,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook({ ...huntBook, gatherGraceActive: true }, coal),
      false,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook({ ...huntBook, fishCodBackoffActive: true }, coal),
      false,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(
        {
          ...huntBook,
          preferredActions: ['cook_cod', 'hunt_battle_batch'],
          interruptActions: ['cook_cod', 'hunt_battle_batch'],
        },
        { busy: true, currentResource: 'Cooked Cod', skill: 'cooking', pageText: '' },
      ),
      false,
    );
  });
});
