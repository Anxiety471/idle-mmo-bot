import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getLogDir } from '../logging/jsonl-writer.js';
import type { GameSnapshot } from '../types.js';
import {
  evaluatePlaybook,
  filterAllowedByPlaybook,
  notePlaybookOutcome,
  resolvePlaybookStatePath,
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
    coalBusyCycles: 0,
    codBusyCycles: 0,
  };
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
    targets: { coalMin: 30, coalMax: 50, codMin: 30, codMax: 50 },
    curriculumHint: 'fish',
    complete: false,
    gatherGraceActive: true,
    gatherGraceSkill: 'fishing',
    gatherGraceResource: 'Cod',
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
        counts: { ...emptyPlaybookCounts(), codBusyCycles: 5 },
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
      `${JSON.stringify({ version: 1, stage: 'buy_bait', counts: emptyPlaybookCounts(), baitOwned: false })}\n`,
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
});
