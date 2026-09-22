import dotenv from 'dotenv';
import { applyCharacterPathEnv } from './character/paths.js';

dotenv.config();

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export interface AppConfig {
  baseUrl: string;
  pollMs: number;
  headless: boolean;
  storageStatePath: string | undefined;
  /** When true, fishing may buy Cheap Bait at /merchants before retrying. Off by default. */
  buyBait: boolean;
  /** When true, combat/gather may click Start anyway on replace dialog. Off by default. */
  forceInterrupt: boolean;
  /** Gold floor — sell_junk_for_gold may run when snapshot gold is below this (default 800). */
  sellGoldThreshold: number;
  /** In-game character name this process should drive (optional). */
  characterName: string | undefined;
  /** Account slug for log path layout (optional; derived from STORAGE_STATE when unset). */
  accountSlug: string | undefined;
}

export function loadConfig(): AppConfig {
  const storageStatePath = process.env.STORAGE_STATE?.trim() || undefined;
  const characterName = process.env.CHARACTER_NAME?.trim() || undefined;
  const accountSlug = process.env.ACCOUNT_SLUG?.trim() || undefined;

  applyCharacterPathEnv({
    storageStatePath,
    characterName,
    accountSlug,
    autopilotLogDir: process.env.AUTOPILOT_LOG_DIR?.trim(),
    playbookStatePath: process.env.PLAYBOOK_STATE_PATH?.trim(),
  });

  return {
    baseUrl: process.env.BASE_URL ?? 'https://web.idle-mmo.com',
    pollMs: parseIntEnv(process.env.POLL_MS, 5000),
    headless: parseBool(process.env.HEADLESS, true),
    storageStatePath,
    buyBait: parseBool(process.env.BUY_BAIT, false),
    forceInterrupt: parseBool(process.env.FORCE_INTERRUPT, false),
    sellGoldThreshold: parseIntEnv(process.env.SELL_GOLD_THRESHOLD, 800),
    characterName,
    accountSlug,
  };
}
