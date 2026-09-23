import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  evaluatePlaybook,
  shouldInterruptGatherForPlaybook,
  type PlaybookProgress,
} from '../autopilot/early-systems-playbook.js';
import type { AutopilotContext, GameSnapshot, GatherState } from '../types.js';
import { ConsoleJev } from './console-jev.js';
import { HttpJev, type SystemOneClient } from './http-jev.js';
import type { JevConfig } from './jev-config.js';
import { ProgressiveStubJev } from './progressive-stub.js';
import type { Question, SystemOneResponse } from './typesafe-client.js';

const config: JevConfig = {
  apiToken: 'test-token',
  model: 'test-model',
  noulThreshold: 0.6,
  apiUrl: 'http://127.0.0.1:9/systemone',
};

const context: AutopilotContext = { cycle: 3, gatherRotationIndex: 0 };

function playbook(overrides: Partial<PlaybookProgress> = {}): PlaybookProgress {
  return {
    enabled: true,
    stage: 'cook_cod',
    stageIndex: 4,
    stageGoal: 'cook',
    preferredActions: ['cook_cod'],
    deprioritizedActions: [],
    interruptActions: ['cook_cod'],
    counts: {
      coal: 100,
      rawCod: 100,
      cookedCod: 0,
      sells: 1,
      huntBattles: 0,
      mapPeeks: 0,
      petManages: 0,
      batchCycles: 0,
      coalBusyCycles: 0,
      codBusyCycles: 0,
    },
    baitOwned: true,
    targets: {
      coalMin: 100,
      coalMax: 100,
      codMin: 100,
      codMax: 100,
      cookMin: 100,
      huntMin: 120,
    },
    curriculumHint: 'cook',
    complete: false,
    gatherGraceActive: false,
    fishCodBackoffActive: false,
    consecutiveFishCodFailures: 0,
    staleCoalGather: false,
    staleCoalBusyCycles: 0,
    ...overrides,
  };
}

function snapshot(
  book: PlaybookProgress | undefined,
  overrides: Partial<GameSnapshot> = {},
): GameSnapshot {
  const { extensions, ...rest } = overrides;
  return {
    location: 'Melriel',
    pagePath: '/cooking',
    skillLevels: {},
    inventory: { Cod: 40, 'Coal Ore': 40, 'Cooked Cod': 10 },
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
    extensions: {
      ...(book ? { earlySystemsPlaybook: book } : {}),
      ...extensions,
    },
    ...rest,
  };
}

function gather(partial: Partial<GatherState> = {}): GatherState {
  return { busy: false, pageText: '', ...partial };
}

function recordingClient(
  calls: string[],
  respond?: (key: string) => SystemOneResponse,
): SystemOneClient {
  return {
    async systemOne(_state: unknown, questions: Record<string, Question>) {
      const key = Object.keys(questions)[0] ?? 'unknown';
      calls.push(key);
      if (!respond) {
        throw new Error(`TypeSafe ${key} should not be called`);
      }
      return respond(key);
    },
  };
}

describe('HttpJev early playbook deterministic choice', () => {
  let logDir: string;
  const previousLogDir = process.env.AUTOPILOT_LOG_DIR;

  before(() => {
    logDir = mkdtempSync(join(tmpdir(), 'jev-playbook-'));
    process.env.AUTOPILOT_LOG_DIR = logDir;
  });

  after(() => {
    if (previousLogDir === undefined) delete process.env.AUTOPILOT_LOG_DIR;
    else process.env.AUTOPILOT_LOG_DIR = previousLogDir;
    rmSync(logDir, { recursive: true, force: true });
  });

  it('chooseNextAction matches ProgressiveStub and never calls TypeSafe while playbook is incomplete', async () => {
    const cases: { name: string; snap: GameSnapshot; allowed: string[] }[] = [
      {
        name: 'cook_cod',
        snap: snapshot(playbook()),
        allowed: ['cook_cod', 'mine_coal', 'idle', 'continue_current'],
      },
      {
        name: 'mine_coal',
        snap: snapshot(
          playbook({
            stage: 'mine_coal',
            preferredActions: ['mine_coal', 'continue_current'],
            interruptActions: ['mine_coal'],
          }),
          { currentAction: { busy: true, resource: 'Oak Log', skill: 'woodcutting' } },
        ),
        allowed: ['mine_coal', 'gather_oak', 'continue_current', 'idle'],
      },
      {
        name: 'fish_cod',
        snap: snapshot(
          playbook({
            stage: 'fish_cod',
            preferredActions: ['fish_cod', 'continue_current'],
            interruptActions: ['fish_cod'],
          }),
          { currentAction: { busy: true, resource: 'Oak Log', skill: 'woodcutting' } },
        ),
        allowed: ['fish_cod', 'buy_bait', 'continue_current', 'idle'],
      },
      {
        name: 'fish backoff continue',
        snap: snapshot(
          playbook({
            stage: 'fish_cod',
            fishCodBackoffActive: true,
            preferredActions: ['continue_current', 'cook_cod', 'mine_coal', 'idle'],
            interruptActions: ['cook_cod'],
          }),
        ),
        allowed: ['fish_cod', 'continue_current', 'cook_cod', 'idle'],
      },
      {
        name: 'quest turn-in before cook',
        snap: snapshot(playbook(), {
          acceptedQuests: [
            { title: 'Wood for the Hearth', canTurnIn: true, tab: 'accepted', progress: '150/150' },
          ],
        }),
        allowed: ['quest_turnin', 'cook_cod', 'gather_oak', 'idle'],
      },
    ];

    const stub = new ProgressiveStubJev();
    for (const entry of cases) {
      const calls: string[] = [];
      const jev = new HttpJev(config, recordingClient(calls));
      const lines: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      };
      try {
        const action = await jev.chooseNextAction(entry.snap, entry.allowed, context);
        const expected = await stub.chooseNextAction(entry.snap, entry.allowed, context);
        assert.equal(action, expected, entry.name);
        assert.deepEqual(calls, [], entry.name);
        assert.ok(
          lines.some(
            (line) =>
              line === `[playbook] deterministic chooseNextAction → ${action} (skipped HttpJev)`,
          ),
          entry.name,
        );
      } finally {
        console.log = original;
      }
    }
  });

  it('shouldInterruptGather skips TypeSafe and follows playbook resource, grace, and backoff', async () => {
    const calls: string[] = [];
    const jev = new HttpJev(config, recordingClient(calls));
    const cook = snapshot(playbook());
    await jev.chooseNextAction(cook, ['cook_cod', 'idle'], context);
    assert.deepEqual(calls, []);

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const interruptOak = await jev.shouldInterruptGather(
        gather({ busy: true, currentResource: 'Oak Log', skill: 'woodcutting' }),
      );
      assert.equal(interruptOak, true);
      const keepCooking = await jev.shouldInterruptGather(
        gather({
          busy: false,
          busyElsewhere: { skill: 'cooking', resource: 'Cod' },
        }),
      );
      assert.equal(keepCooking, false);
      assert.deepEqual(calls, []);
      assert.ok(
        lines.some(
          (line) =>
            line === '[playbook] deterministic shouldInterruptGather → true (skipped HttpJev)',
        ),
      );
    } finally {
      console.log = original;
    }

    const grace = new HttpJev(config, recordingClient(calls));
    await grace.chooseNextAction(
      snapshot(
        playbook({
          stage: 'fish_cod',
          gatherGraceActive: true,
          preferredActions: ['continue_current', 'fish_cod'],
          interruptActions: ['fish_cod'],
        }),
      ),
      ['continue_current', 'fish_cod', 'idle'],
      context,
    );
    assert.equal(
      await grace.shouldInterruptGather(
        gather({ busy: true, currentResource: 'Oak Log', skill: 'woodcutting' }),
      ),
      false,
    );

    const backoff = new HttpJev(config, recordingClient(calls));
    await backoff.chooseNextAction(
      snapshot(
        playbook({
          stage: 'fish_cod',
          fishCodBackoffActive: true,
          preferredActions: ['continue_current', 'cook_cod', 'idle'],
          interruptActions: ['cook_cod'],
        }),
      ),
      ['continue_current', 'cook_cod', 'fish_cod', 'idle'],
      context,
    );
    assert.equal(
      await backoff.shouldInterruptGather(
        gather({ busy: true, currentResource: 'Oak Log', skill: 'woodcutting' }),
      ),
      false,
    );

    const stale = new HttpJev(config, recordingClient(calls));
    await stale.chooseNextAction(
      snapshot(
        playbook({
          stage: 'mine_coal',
          staleCoalGather: true,
          preferredActions: ['mine_coal'],
          interruptActions: ['mine_coal'],
        }),
      ),
      ['mine_coal', 'continue_current', 'idle'],
      context,
    );
    assert.equal(
      await stale.shouldInterruptGather(
        gather({ busy: true, currentResource: 'Coal Ore', skill: 'mining' }),
      ),
      true,
    );

    const onCoal = new HttpJev(config, recordingClient(calls));
    await onCoal.chooseNextAction(
      snapshot(
        playbook({
          stage: 'mine_coal',
          preferredActions: ['mine_coal', 'continue_current'],
          interruptActions: ['mine_coal', 'manage_pets'],
        }),
      ),
      ['mine_coal', 'manage_pets', 'idle'],
      context,
    );
    assert.equal(
      await onCoal.shouldInterruptGather(
        gather({ busy: true, currentResource: 'Coal Ore', skill: 'mining' }),
      ),
      false,
    );

    assert.deepEqual(calls, []);
  });

  it('uses the TypeSafe API once the playbook is complete or disabled', async () => {
    const calls: string[] = [];
    const client = recordingClient(calls, (key): SystemOneResponse => {
      if (key === 'action') {
        return { model: 'test', answers: { action: { type: 'choice', choice: 'idle' } } };
      }
      if (key === 'interrupt') {
        return { model: 'test', answers: { interrupt: { type: 'noul', noul: 0.91 } } };
      }
      throw new Error(`unexpected ${key}`);
    });
    const jev = new HttpJev(config, client);
    const complete = snapshot(playbook({ complete: true, stage: 'complete', preferredActions: [] }));
    const action = await jev.chooseNextAction(complete, ['gather_oak', 'idle'], context);
    assert.equal(action, 'idle');
    assert.deepEqual(calls, ['action']);

    const seeded = new HttpJev(config, client);
    await seeded.chooseNextAction(complete, ['idle'], context);
    const interrupt = await seeded.shouldInterruptGather(
      gather({ busy: true, currentResource: 'Oak Log', skill: 'woodcutting' }),
    );
    assert.equal(interrupt, true);
    assert.deepEqual(calls, ['action', 'interrupt']);

    const disabled = new HttpJev(config, client);
    const without = await disabled.chooseNextAction(
      snapshot(undefined),
      ['gather_oak', 'idle'],
      context,
    );
    assert.equal(without, 'idle');
    assert.deepEqual(calls, ['action', 'interrupt', 'action']);

    const noSnapshot = new HttpJev(config, client);
    const blind = await noSnapshot.shouldInterruptGather(
      gather({ busy: true, currentResource: 'Oak Log' }),
    );
    assert.equal(blind, true);
    assert.deepEqual(calls, ['action', 'interrupt', 'action', 'interrupt']);
  });

  it('still calls TypeSafe for combat stance while the playbook is choosing actions', async () => {
    const calls: string[] = [];
    const jev = new HttpJev(
      config,
      recordingClient(calls, (key): SystemOneResponse => {
        if (key !== 'stance') throw new Error(`unexpected ${key}`);
        return { model: 'test', answers: { stance: { type: 'choice', choice: 'Offensive' } } };
      }),
    );
    const action = await jev.chooseNextAction(
      snapshot(playbook()),
      ['cook_cod', 'idle'],
      context,
    );
    assert.equal(action, 'cook_cod');
    const stance = await jev.chooseStance({ name: 'Rabbit', index: 0 });
    assert.equal(stance, 'Offensive');
    assert.deepEqual(calls, ['stance']);
  });

  it('ConsoleJev still prints the deterministic action', async () => {
    const jev = new ConsoleJev(new HttpJev(config, recordingClient([])));
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const action = await jev.chooseNextAction(
        snapshot(playbook({ stage: 'mine_coal', preferredActions: ['mine_coal'], interruptActions: ['mine_coal'] })),
        ['mine_coal', 'gather_oak', 'idle'],
        context,
      );
      assert.equal(action, 'mine_coal');
    } finally {
      console.log = original;
    }
    assert.ok(lines.some((line) => line.includes('[Jev:Console] chooseNextAction') && line.includes('mine_coal')));
    assert.ok(
      lines.some(
        (line) => line === '[playbook] deterministic chooseNextAction → mine_coal (skipped HttpJev)',
      ),
    );
  });

  it('chooseNextAction returns hunt_battle_batch for a pending hard kill quest and skips TypeSafe', async () => {
    const statePath = join(logDir, 'hitori-playbook.json');
    const previousState = process.env.PLAYBOOK_STATE_PATH;
    const previousPlaybook = process.env.EARLY_PLAYBOOK;
    process.env.PLAYBOOK_STATE_PATH = statePath;
    process.env.EARLY_PLAYBOOK = 'true';
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        stage: 'hunt_battle_batch',
        counts: {
          coal: 100,
          rawCod: 100,
          cookedCod: 111,
          sells: 1,
          huntBattles: 41,
          mapPeeks: 0,
          petManages: 1,
          batchCycles: 1,
          coalBusyCycles: 0,
          codBusyCycles: 0,
        },
        baitOwned: true,
      })}\n`,
    );
    try {
      const base = snapshot(undefined, {
        inventory: { 'Cheap Bait': 8, 'Coal Ore': 40, Cod: 20, 'Cooked Cod': 111 },
        gold: 110,
        combatLevel: 2,
        combatPhase: 'none',
        pendingQuests: [
          { title: 'A Rabbits Fortune', progress: '1 / 40', canTurnIn: false, tab: 'pending' },
        ],
      });
      const progress = evaluatePlaybook(base);
      assert.equal(progress.preferredActions[0], 'hunt_battle_batch');
      const calls: string[] = [];
      const jev = new HttpJev(config, recordingClient(calls));
      const action = await jev.chooseNextAction(
        snapshot(progress, {
          inventory: base.inventory,
          gold: 110,
          combatLevel: 2,
          combatPhase: 'none',
          pendingQuests: base.pendingQuests,
        }),
        ['quest_talk_accept', 'hunt_battle_batch', 'hunt_battle', 'idle'],
        context,
      );
      assert.equal(action, 'hunt_battle_batch');
      assert.deepEqual(calls, []);
    } finally {
      if (previousState === undefined) delete process.env.PLAYBOOK_STATE_PATH;
      else process.env.PLAYBOOK_STATE_PATH = previousState;
      if (previousPlaybook === undefined) delete process.env.EARLY_PLAYBOOK;
      else process.env.EARLY_PLAYBOOK = previousPlaybook;
    }
  });

  it('interrupts busy Coal Ore when preferred/interrupt wants hunt', () => {
    const coal = gather({ busy: true, currentResource: 'Coal Ore', skill: 'mining' });
    assert.equal(
      shouldInterruptGatherForPlaybook(
        playbook({
          stage: 'hunt_battle_batch',
          preferredActions: ['hunt_battle_batch', 'hunt_battle'],
          interruptActions: ['mine_coal', 'hunt_battle_batch', 'hunt_battle'],
        }),
        coal,
      ),
      true,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(
        playbook({
          stage: 'hunt_battle_batch',
          preferredActions: ['hunt_battle_batch'],
          interruptActions: ['mine_coal'],
        }),
        coal,
      ),
      true,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(
        playbook({
          stage: 'hunt_battle_batch',
          preferredActions: ['cook_cod', 'hunt_battle_batch'],
          interruptActions: ['cook_cod', 'hunt_battle_batch'],
          gatherGraceActive: true,
        }),
        coal,
      ),
      false,
    );
  });

  it('playbook interrupt helper matches coal, cod, cook, grace, and backoff', () => {
    const oak = gather({ busy: true, currentResource: 'Oak Log', skill: 'woodcutting' });
    assert.equal(shouldInterruptGatherForPlaybook(playbook(), oak), true);
    assert.equal(
      shouldInterruptGatherForPlaybook(
        playbook(),
        gather({ busy: false, busyElsewhere: { skill: 'cooking', resource: 'Cod' } }),
      ),
      false,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(
        playbook({ stage: 'fish_cod', gatherGraceActive: true, interruptActions: ['fish_cod'] }),
        oak,
      ),
      false,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(
        playbook({ stage: 'fish_cod', fishCodBackoffActive: true, interruptActions: ['cook_cod'] }),
        oak,
      ),
      false,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(
        playbook({
          stage: 'hunt_battle_batch',
          interruptActions: ['hunt_battle_batch', 'hunt_battle'],
        }),
        oak,
      ),
      true,
    );
    assert.equal(
      shouldInterruptGatherForPlaybook(playbook({ complete: true }), oak),
      false,
    );
  });
});
