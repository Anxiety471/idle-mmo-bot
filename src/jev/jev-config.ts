import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_NOUL_THRESHOLD = 0.6;

function parseFloatEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export interface JevConfig {
  apiToken: string;
  model: string;
  noulThreshold: number;
  apiUrl: string;
}

/** Resolve API token from JEV_API_TOKEN or TYPESAFE_API_KEY. */
export function resolveJevApiToken(): string | undefined {
  const token = process.env.JEV_API_TOKEN?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  return token || undefined;
}

export function loadJevConfig(): JevConfig | undefined {
  const apiToken = resolveJevApiToken();
  if (!apiToken) return undefined;

  return {
    apiToken,
    model: process.env.JEV_MODEL?.trim() || DEFAULT_MODEL,
    noulThreshold: parseFloatEnv(process.env.JEV_NOUL_THRESHOLD, DEFAULT_NOUL_THRESHOLD),
    apiUrl: process.env.JEV_API_URL?.trim() || DEFAULT_API_URL,
  };
}
