import dotenv from 'dotenv';

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
}

export function loadConfig(): AppConfig {
  return {
    baseUrl: process.env.BASE_URL ?? 'https://web.idle-mmo.com',
    pollMs: parseIntEnv(process.env.POLL_MS, 5000),
    headless: parseBool(process.env.HEADLESS, true),
    storageStatePath: process.env.STORAGE_STATE?.trim() || undefined,
    buyBait: parseBool(process.env.BUY_BAIT, false),
    forceInterrupt: parseBool(process.env.FORCE_INTERRUPT, false),
  };
}
