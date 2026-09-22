import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getLogDir } from '../logging/jsonl-writer.js';
import type { GameSnapshot } from '../types.js';
import {
  coalTargetMet,
  evaluatePlaybook,
  filterAllowedByPlaybook,
  FISH_COD_BACKOFF_MS,
  FISH_COD_FAILURE_THRESHOLD,
  notePlaybookOutcome,
  recentBaitPurchase,
  resolvePlaybookStatePath,
  shouldPreferBaitRestock,
  type PlaybookProgress,
} from './early-systems-playbook.js';

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
    rabbitHunts: 0,
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
    targets: { coalMin: 100, coalMax: 100, codMin: 100, codMax: 100, cookMin: 100, huntMin: 50 },
    curriculumHint: 'fish',
    complete: false,
    gatherGraceActive: true,
    gatherGraceSkill: 'fishing',
    gatherGraceResource: 'Cod',
    fishCodBackoffActive: false,
    consecutiveFishCodFailures: 0,
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
      targets: { coalMin: 100, coalMax: 100, codMin: 100, codMax: 100, cookMin: 100, huntMin: 50 },
      curriculumHint: 'sell',
      complete: false,
      gatherGraceActive: false,
      fishCodBackoffActive: false,
      consecutiveFishCodFailures: 0,
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

  it('defaults to 100/100/100/50 targets and loops after pets', () => {
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
        stage: 'manage_pets',
        counts: {
          coal: 100,
          rawCod: 100,
          cookedCod: 100,
          sells: 2,
          rabbitHunts: 50,
          mapPeeks: 1,
          petManages: 0,
          batchCycles: 1,
          coalBusyCycles: 300,
          codBusyCycles: 300,
        },
        baitOwned: true,
      }),
    );

    notePlaybookOutcome('manage_pets', 'no_pets');
    const progress = evaluatePlaybook(
      minimalSnapshot({
        inventory: { 'Cheap Bait': 5, 'Coal Ore': 0, Cod: 0, 'Cooked Cod': 0 },
        gold: 50,
      }),
    );
    assert.equal(progress.targets.coalMin, 100);
    assert.equal(progress.targets.codMin, 100);
    assert.equal(progress.targets.cookMin, 100);
    assert.equal(progress.targets.huntMin, 50);
    assert.equal(progress.complete, false);
    assert.equal(progress.stage, 'mine_coal');
    assert.ok(progress.counts.batchCycles >= 2);
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
});
