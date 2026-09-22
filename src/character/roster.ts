/**
 * In-account character roster rotation.
 *
 * When CHARACTER_ROSTER lists multiple alts, autopilot can round-robin to the next
 * character while the current one is gatherBusy — so other alts keep progressing.
 * Separate accounts (different STORAGE_STATE) stay isolated; roster is per-process.
 *
 * Game limit: up to 5 chars / 3 active — only rotate among names in CHARACTER_ROSTER.
 */
import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import { selectCharacterByName } from './character-select.js';
import {
  characterNamesMatch,
  resolveCharacterPaths,
  type CharacterPathInput,
  type ResolvedCharacterPaths,
} from './paths.js';

/** Parse CHARACTER_ROSTER (+ optional CHARACTER_NAME as primary). Empty = no rotation (legacy). */
export function parseCharacterRoster(
  characterName?: string,
  rosterEnv: string | undefined = process.env.CHARACTER_ROSTER,
): string[] {
  const extras = (rosterEnv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extras.length === 0) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(n);
  };

  const primary = characterName?.trim();
  if (primary) add(primary);
  for (const n of extras) add(n);
  return names;
}

/** Next name in round-robin; undefined when roster has fewer than 2 characters. */
export function nextRosterCharacter(
  roster: string[],
  current: string | undefined,
): string | undefined {
  if (roster.length < 2) return undefined;
  const idx = roster.findIndex((n) => characterNamesMatch(n, current));
  if (idx < 0) return roster[0];
  return roster[(idx + 1) % roster.length];
}

export interface BusyFlags {
  gatherBusy?: boolean;
  inBattle?: boolean;
  currentActionBusy?: boolean;
}

/**
 * Rotate when gathering/acting (not mid-battle) and another roster alt exists.
 * inBattle stays on the current character so combat UI is not abandoned.
 */
export function shouldRotateWhileBusy(
  roster: string[],
  current: string | undefined,
  flags: BusyFlags,
): boolean {
  if (roster.length < 2) return false;
  if (flags.inBattle) return false;
  const busy = Boolean(flags.gatherBusy || flags.currentActionBusy);
  if (!busy) return false;
  return Boolean(nextRosterCharacter(roster, current));
}

/**
 * Force per-character log/playbook paths for roster switches.
 * Explicit path env from a previous character must not stick across alts.
 */
export function forceApplyCharacterPathEnv(
  characterName: string,
  input: Omit<CharacterPathInput, 'characterName' | 'autopilotLogDir' | 'playbookStatePath'> = {},
): ResolvedCharacterPaths {
  const trimmed = characterName.trim();
  process.env.CHARACTER_NAME = trimmed;
  const resolved = resolveCharacterPaths({
    ...input,
    characterName: trimmed,
  });
  process.env.AUTOPILOT_LOG_DIR = resolved.autopilotLogDir;
  process.env.PLAYBOOK_STATE_PATH = resolved.playbookStatePath;
  return resolved;
}

export interface RosterSwitchResult {
  ok: boolean;
  from?: string;
  to: string;
  paths?: ResolvedCharacterPaths;
  message?: string;
}

/**
 * Switch in-game character and reload CHARACTER_NAME + playbook/log paths.
 * Callers should update AppConfig.characterName and AutopilotContext after success.
 */
export async function rotateToRosterCharacter(
  page: Page,
  config: AppConfig,
  targetName: string,
): Promise<RosterSwitchResult> {
  const from = config.characterName;
  const switched = await selectCharacterByName(page, config, targetName);
  if (!switched) {
    return {
      ok: false,
      from,
      to: targetName,
      message: `selectCharacterByName failed for "${targetName}" (roster UI best-effort)`,
    };
  }

  const paths = forceApplyCharacterPathEnv(targetName, {
    storageStatePath: config.storageStatePath,
    accountSlug: config.accountSlug,
  });
  config.characterName = targetName;

  return { ok: true, from, to: targetName, paths };
}
