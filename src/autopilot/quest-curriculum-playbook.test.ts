import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { GameSnapshot } from '../types.js';
import { evaluatePlaybook, filterAllowedByPlaybook } from './early-systems-playbook.js';
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

function coalMetCounts(overrides: Record<string, number> = {}) {
  return { ...emptyPlaybookCounts(), coal: 100, coalBusyCycles: 300, ...overrides };
}

function minimalSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    location: 'Melriel',
    pagePath: '/fishing',
    skillLevels: { woodcutting: 5 },
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

describe('quest curriculum playbook integration', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath: string;

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  function playbookFor(snapshot: GameSnapshot) {
    statePath = join('/tmp', `playbook-quest-${Date.now()}-${Math.random()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: coalMetCounts(),
        baitOwned: true,
      })}\n`,
    );
    return evaluatePlaybook(snapshot);
  }

  it('filterAllowedByPlaybook prefers gather_oak over fish_cod when hearth quest accepted', () => {
    const snapshot = minimalSnapshot({
      acceptedQuests: [
        { title: 'Wood for the Hearth', progress: '42 / 150', canTurnIn: false, tab: 'accepted' },
      ],
    });
    const playbook = playbookFor(snapshot);
    const allowed = ['fish_cod', 'gather_oak', 'continue_current', 'idle'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.ok(!filtered.includes('fish_cod'));
    assert.ok(filtered.includes('gather_oak'));
    assert.ok(filtered.indexOf('gather_oak') < filtered.indexOf('continue_current'));
  });

  it('hard combat quest at combat 1 does not block easy gather preference', () => {
    const snapshot = minimalSnapshot({
      combatLevel: 1,
      acceptedQuests: [
        { title: 'Goblin Menace', progress: '0 / 30', canTurnIn: false, tab: 'accepted' },
        { title: 'Wood for the Hearth', progress: '10 / 150', canTurnIn: false, tab: 'accepted' },
      ],
    });
    const playbook = playbookFor(snapshot);
    const allowed = ['hunt_battle', 'gather_oak', 'fish_cod', 'idle'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.ok(filtered.includes('gather_oak'));
    assert.ok(!filtered.includes('fish_cod'));
    assert.ok(!filtered.includes('hunt_battle'));
    assert.equal(filtered[0], 'gather_oak');
  });

  it('canTurnIn sorts quest_turnin first', () => {
    const snapshot = minimalSnapshot({
      acceptedQuests: [
        { title: 'Wood for the Hearth', progress: '150 / 150', canTurnIn: true, tab: 'accepted' },
      ],
    });
    const playbook = playbookFor(snapshot);
    const allowed = ['gather_oak', 'quest_turnin', 'fish_cod', 'idle'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.equal(filtered[0], 'quest_turnin');
  });

  it('sell still works when no quests', () => {
    statePath = join('/tmp', `playbook-quest-sell-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'sell_half',
        counts: coalMetCounts(),
        baitOwned: false,
      })}\n`,
    );
    const snapshot = minimalSnapshot({ acceptedQuests: [], pendingQuests: [] });
    const playbook = evaluatePlaybook(snapshot);
    const allowed = ['idle', 'market_sell_half', 'sell_junk_for_gold'];

    const filtered = filterAllowedByPlaybook(allowed, snapshot, playbook);

    assert.equal(filtered[0], 'sell_junk_for_gold');
    assert.ok(filtered.indexOf('sell_junk_for_gold') < filtered.indexOf('market_sell_half'));
  });
});

describe('ProgressiveStubJev quest curriculum', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let statePath: string;
  const stub = new ProgressiveStubJev();

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (statePath) rmSync(statePath, { force: true });
  });

  it('chooses gather_oak over fish_cod when hearth quest is active', async () => {
    statePath = join('/tmp', `playbook-stub-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'fish_cod',
        counts: coalMetCounts(),
        baitOwned: true,
      })}\n`,
    );
    const snapshot = minimalSnapshot({
      acceptedQuests: [
        { title: 'Wood for the Hearth', progress: '42 / 150', canTurnIn: false, tab: 'accepted' },
      ],
    });
    snapshot.extensions = { earlySystemsPlaybook: evaluatePlaybook(snapshot) };

    const action = await stub.chooseNextAction(snapshot, ['fish_cod', 'gather_oak', 'idle'], {
      cycle: 1,
      gatherRotationIndex: 0,
    });

    assert.equal(action, 'gather_oak');
  });

  it('chooses quest_turnin when canTurnIn', async () => {
    statePath = join('/tmp', `playbook-stub-turnin-${Date.now()}.json`);
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, stage: 'fish_cod', counts: coalMetCounts(), baitOwned: true })}\n`,
    );
    const snapshot = minimalSnapshot({
      acceptedQuests: [
        { title: 'Wood for the Hearth', progress: '150 / 150', canTurnIn: true, tab: 'accepted' },
      ],
    });
    snapshot.extensions = { earlySystemsPlaybook: evaluatePlaybook(snapshot) };

    const action = await stub.chooseNextAction(snapshot, ['gather_oak', 'quest_turnin', 'idle'], {
      cycle: 1,
      gatherRotationIndex: 0,
    });

    assert.equal(action, 'quest_turnin');
  });
});
