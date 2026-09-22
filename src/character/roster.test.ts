import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  forceApplyCharacterPathEnv,
  nextRosterCharacter,
  parseCharacterRoster,
  shouldRotateWhileBusy,
} from './roster.js';

const ENV_KEYS = ['CHARACTER_NAME', 'CHARACTER_ROSTER', 'AUTOPILOT_LOG_DIR', 'PLAYBOOK_STATE_PATH'] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) out[key] = process.env[key];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

describe('parseCharacterRoster', () => {
  it('returns empty when CHARACTER_ROSTER unset (legacy single-character)', () => {
    assert.deepEqual(parseCharacterRoster('IdleBocchi', undefined), []);
    assert.deepEqual(parseCharacterRoster('IdleBocchi', ''), []);
    assert.deepEqual(parseCharacterRoster(undefined, '  '), []);
  });

  it('parses comma-separated roster', () => {
    assert.deepEqual(parseCharacterRoster(undefined, 'AltOne, AltTwo, AltThree'), [
      'AltOne',
      'AltTwo',
      'AltThree',
    ]);
  });

  it('puts CHARACTER_NAME first then roster extras without dupes', () => {
    assert.deepEqual(parseCharacterRoster('Main', 'AltOne,Main,AltTwo'), [
      'Main',
      'AltOne',
      'AltTwo',
    ]);
  });

  it('case-insensitive dedupe keeps first spelling', () => {
    assert.deepEqual(parseCharacterRoster('IdleBocchi', 'idlebocchi,MinerAlt'), [
      'IdleBocchi',
      'MinerAlt',
    ]);
  });
});

describe('nextRosterCharacter', () => {
  it('returns undefined for single or empty roster', () => {
    assert.equal(nextRosterCharacter([], 'A'), undefined);
    assert.equal(nextRosterCharacter(['Only'], 'Only'), undefined);
  });

  it('round-robins through roster', () => {
    const roster = ['A', 'B', 'C'];
    assert.equal(nextRosterCharacter(roster, 'A'), 'B');
    assert.equal(nextRosterCharacter(roster, 'B'), 'C');
    assert.equal(nextRosterCharacter(roster, 'C'), 'A');
  });

  it('falls back to first when current unknown', () => {
    assert.equal(nextRosterCharacter(['A', 'B'], 'Z'), 'A');
  });
});

describe('shouldRotateWhileBusy', () => {
  const roster = ['A', 'B'];

  it('false when no multi-roster', () => {
    assert.equal(shouldRotateWhileBusy(['A'], 'A', { gatherBusy: true }), false);
  });

  it('true when gatherBusy and another alt exists', () => {
    assert.equal(shouldRotateWhileBusy(roster, 'A', { gatherBusy: true }), true);
  });

  it('true when currentActionBusy', () => {
    assert.equal(
      shouldRotateWhileBusy(roster, 'A', { currentActionBusy: true }),
      true,
    );
  });

  it('false when idle', () => {
    assert.equal(shouldRotateWhileBusy(roster, 'A', { gatherBusy: false }), false);
  });

  it('false while inBattle', () => {
    assert.equal(
      shouldRotateWhileBusy(roster, 'A', { gatherBusy: true, inBattle: true }),
      false,
    );
  });
});

describe('forceApplyCharacterPathEnv', () => {
  let envSnap: Record<string, string | undefined>;

  afterEach(() => {
    restoreEnv(envSnap);
  });

  it('rewrites CHARACTER_NAME and per-character paths', () => {
    envSnap = snapshotEnv();
    process.env.AUTOPILOT_LOG_DIR = 'logs/old/char';
    process.env.PLAYBOOK_STATE_PATH = 'logs/old/char/playbook-state.json';

    const paths = forceApplyCharacterPathEnv('MinerAlt', {
      storageStatePath: './storage-state-hitoriidle.json',
    });

    assert.equal(process.env.CHARACTER_NAME, 'MinerAlt');
    assert.equal(paths.autopilotLogDir, 'logs/hitoriidle/mineralt');
    assert.equal(paths.playbookStatePath, 'logs/hitoriidle/mineralt/playbook-state.json');
    assert.equal(process.env.AUTOPILOT_LOG_DIR, paths.autopilotLogDir);
    assert.equal(process.env.PLAYBOOK_STATE_PATH, paths.playbookStatePath);
  });
});
