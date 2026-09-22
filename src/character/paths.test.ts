import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  applyCharacterPathEnv,
  characterNamesMatch,
  deriveAccountSlugFromStorageState,
  resolveCharacterPaths,
  resolvePreferredCharacterName,
  slugifyName,
} from './paths.js';

describe('slugifyName', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(slugifyName('IdleBocchi'), 'idlebocchi');
    assert.equal(slugifyName('  Miner Alt  '), 'miner-alt');
  });
});

describe('deriveAccountSlugFromStorageState', () => {
  it('maps default IdleBocchi storage file', () => {
    assert.equal(deriveAccountSlugFromStorageState('./storage-state.json'), 'idlebocchi');
  });

  it('maps HitoriIdle storage file', () => {
    assert.equal(
      deriveAccountSlugFromStorageState('./storage-state-hitoriidle.json'),
      'hitoriidle',
    );
  });

  it('returns default when unset', () => {
    assert.equal(deriveAccountSlugFromStorageState(undefined), 'default');
  });
});

describe('resolveCharacterPaths', () => {
  it('preserves legacy paths when CHARACTER_NAME is unset', () => {
    const paths = resolveCharacterPaths({
      storageStatePath: './storage-state.json',
    });
    assert.equal(paths.accountSlug, 'idlebocchi');
    assert.equal(paths.characterSlug, 'default');
    assert.equal(paths.autopilotLogDir, 'logs');
    assert.equal(paths.playbookStatePath, 'logs/playbook-state.json');
  });

  it('derives per-character paths under account slug', () => {
    const paths = resolveCharacterPaths({
      storageStatePath: './storage-state-hitoriidle.json',
      characterName: 'FisherAlt',
    });
    assert.equal(paths.accountSlug, 'hitoriidle');
    assert.equal(paths.characterSlug, 'fisheralt');
    assert.equal(paths.autopilotLogDir, 'logs/hitoriidle/fisheralt');
    assert.equal(paths.playbookStatePath, 'logs/hitoriidle/fisheralt/playbook-state.json');
  });

  it('honors explicit log/playbook overrides', () => {
    const paths = resolveCharacterPaths({
      storageStatePath: './storage-state.json',
      characterName: 'IdleBocchi',
      autopilotLogDir: '/custom/logs',
      playbookStatePath: '/custom/playbook.json',
    });
    assert.equal(paths.autopilotLogDir, '/custom/logs');
    assert.equal(paths.playbookStatePath, '/custom/playbook.json');
  });

  it('honors ACCOUNT_SLUG override', () => {
    const paths = resolveCharacterPaths({
      storageStatePath: './storage-state.json',
      characterName: 'AltOne',
      accountSlug: 'my-account',
    });
    assert.equal(paths.accountSlug, 'my-account');
    assert.equal(paths.autopilotLogDir, 'logs/my-account/altone');
  });
});

describe('applyCharacterPathEnv', () => {
  const savedLog = process.env.AUTOPILOT_LOG_DIR;
  const savedPlaybook = process.env.PLAYBOOK_STATE_PATH;

  it('sets env when CHARACTER_NAME is set and paths are unset', () => {
    delete process.env.AUTOPILOT_LOG_DIR;
    delete process.env.PLAYBOOK_STATE_PATH;

    applyCharacterPathEnv({
      storageStatePath: './storage-state.json',
      characterName: 'IdleBocchi',
    });

    assert.equal(process.env.AUTOPILOT_LOG_DIR, 'logs/idlebocchi/idlebocchi');
    assert.equal(process.env.PLAYBOOK_STATE_PATH, 'logs/idlebocchi/idlebocchi/playbook-state.json');
  });

  it('does not override explicit env', () => {
    process.env.AUTOPILOT_LOG_DIR = '/keep/logs';
    process.env.PLAYBOOK_STATE_PATH = '/keep/playbook.json';

    applyCharacterPathEnv({
      storageStatePath: './storage-state.json',
      characterName: 'IdleBocchi',
    });

    assert.equal(process.env.AUTOPILOT_LOG_DIR, '/keep/logs');
    assert.equal(process.env.PLAYBOOK_STATE_PATH, '/keep/playbook.json');
  });

  after(() => {
    if (savedLog === undefined) delete process.env.AUTOPILOT_LOG_DIR;
    else process.env.AUTOPILOT_LOG_DIR = savedLog;
    if (savedPlaybook === undefined) delete process.env.PLAYBOOK_STATE_PATH;
    else process.env.PLAYBOOK_STATE_PATH = savedPlaybook;
  });
});

describe('characterNamesMatch', () => {
  it('matches case-insensitively', () => {
    assert.equal(characterNamesMatch('IdleBocchi', 'idlebocchi'), true);
    assert.equal(characterNamesMatch('IdleBocchi', 'HitoriIdle'), false);
  });
});

describe('resolvePreferredCharacterName', () => {
  it('prefers configured name over active', () => {
    assert.equal(resolvePreferredCharacterName('IdleBocchi', 'Wrong'), 'IdleBocchi');
  });

  it('falls back to active when configured is unset', () => {
    assert.equal(resolvePreferredCharacterName(undefined, 'IdleBocchi'), 'IdleBocchi');
  });
});
