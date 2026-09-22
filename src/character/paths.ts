import { basename, join } from 'node:path';

export interface CharacterPathInput {
  storageStatePath?: string;
  characterName?: string;
  accountSlug?: string;
  autopilotLogDir?: string;
  playbookStatePath?: string;
}

export interface ResolvedCharacterPaths {
  accountSlug: string;
  characterSlug: string;
  autopilotLogDir: string;
  playbookStatePath: string;
}

/** Lowercase slug safe for directory names. */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive account slug from STORAGE_STATE filename.
 * - storage-state.json → idlebocchi (IdleBocchi default account convention)
 * - storage-state-hitoriidle.json → hitoriidle
 */
export function deriveAccountSlugFromStorageState(storageStatePath: string | undefined): string {
  if (!storageStatePath?.trim()) return 'default';

  const file = basename(storageStatePath.trim(), '.json');
  if (file === 'storage-state') return 'idlebocchi';

  const suffixMatch = file.match(/^storage-state-(.+)$/i);
  if (suffixMatch?.[1]) return slugifyName(suffixMatch[1]);

  return slugifyName(file.replace(/^storage-state-?/i, '') || 'default');
}

/**
 * Resolve per-character log/playbook paths.
 *
 * When CHARACTER_NAME is unset, preserves legacy single-character behavior:
 * AUTOPILOT_LOG_DIR defaults to ./logs and playbook to ./logs/playbook-state.json.
 *
 * When CHARACTER_NAME is set, defaults to:
 *   logs/{accountSlug}/{characterSlug}/
 *   logs/{accountSlug}/{characterSlug}/playbook-state.json
 *
 * Explicit AUTOPILOT_LOG_DIR / PLAYBOOK_STATE_PATH always win.
 */
export function resolveCharacterPaths(input: CharacterPathInput): ResolvedCharacterPaths {
  const accountSlug =
    input.accountSlug?.trim() || deriveAccountSlugFromStorageState(input.storageStatePath);
  const characterName = input.characterName?.trim();
  const characterSlug = characterName ? slugifyName(characterName) : 'default';

  const explicitLogDir = input.autopilotLogDir?.trim();
  const explicitPlaybook = input.playbookStatePath?.trim();

  if (!characterName) {
    const autopilotLogDir = explicitLogDir || 'logs';
    return {
      accountSlug,
      characterSlug,
      autopilotLogDir,
      playbookStatePath: explicitPlaybook || join(autopilotLogDir, 'playbook-state.json'),
    };
  }

  const defaultLogDir = join('logs', accountSlug, characterSlug);
  const autopilotLogDir = explicitLogDir || defaultLogDir;

  return {
    accountSlug,
    characterSlug,
    autopilotLogDir,
    playbookStatePath: explicitPlaybook || join(autopilotLogDir, 'playbook-state.json'),
  };
}

/**
 * Apply derived paths to process.env when CHARACTER_NAME is set and paths are not
 * already overridden. Call during loadConfig() so downstream modules see consistent env.
 */
export function applyCharacterPathEnv(input: CharacterPathInput): ResolvedCharacterPaths {
  const resolved = resolveCharacterPaths(input);

  if (input.characterName?.trim()) {
    if (!process.env.AUTOPILOT_LOG_DIR?.trim()) {
      process.env.AUTOPILOT_LOG_DIR = resolved.autopilotLogDir;
    }
    if (!process.env.PLAYBOOK_STATE_PATH?.trim()) {
      process.env.PLAYBOOK_STATE_PATH = resolved.playbookStatePath;
    }
  }

  return resolved;
}

/** Case-insensitive character name match for selection/bootstrap. */
export function characterNamesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Prefer explicit CHARACTER_NAME; fall back to active in-game name when unset. */
export function resolvePreferredCharacterName(
  configuredName: string | undefined,
  activeName: string | undefined,
): string | undefined {
  const configured = configuredName?.trim();
  if (configured) return configured;
  const active = activeName?.trim();
  return active || undefined;
}
