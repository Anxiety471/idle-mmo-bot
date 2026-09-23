import { parseQuantityString, matchKnownItem } from '../snapshot/inventory-scrape.js';
import type { CurrentActionInfo, SkillId } from '../types.js';

/**
 * IdleMMO Public API client.
 *
 * Wiki: https://wiki.idle-mmo.com/more/api
 * Only `/v1/` routes are called. Inventory has no path on the public wiki;
 * set `IDLE_MMO_INVENTORY_PATH` to the `/v1/` path copied from in-game API settings.
 */

export const DEFAULT_API_BASE = 'https://api.idle-mmo.com';
export const IDLE_MMO_BOT_USER_AGENT = 'idle-mmo-bot/1.0.0 (Contact: local-overseer)';

/** Wiki example plus character routes published with official scope ids. */
export const DOCUMENTED_PATHS = {
  authCheck: '/v1/auth/check',
  characterInformation: '/v1/character/{hashed_character_id}/information',
  currentAction: '/v1/character/{hashed_character_id}/current-action',
} as const;

/** Standard public-API limit is 20 requests/minute → 3s minimum spacing. */
export const DEFAULT_MIN_INTERVAL_MS = 3_000;
export const DEFAULT_CACHE_TTL_MS = 30_000;
const AUTH_CACHE_TTL_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;

const SKILL_IDS: readonly SkillId[] = [
  'woodcutting',
  'mining',
  'fishing',
  'alchemy',
  'smelting',
  'cooking',
  'forge',
  'construction',
];

const ALIAS_TO_CANONICAL: Record<string, string> = {
  Coal: 'Coal Ore',
  Cod: 'Raw Cod',
  Bait: 'Cheap Bait',
};

export type IdleMmoApiErrorCode =
  | 'missing_key'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'bad_response'
  | 'http';

export class IdleMmoApiError extends Error {
  readonly code: IdleMmoApiErrorCode;
  readonly status?: number;

  constructor(message: string, code: IdleMmoApiErrorCode, status?: number) {
    super(message);
    this.name = 'IdleMmoApiError';
    this.code = code;
    this.status = status;
  }
}

export interface IdleMmoApiConfig {
  apiKey: string;
  baseUrl: string;
  userAgent: string;
  minIntervalMs: number;
  cacheTtlMs: number;
  /** Hashed character id from API settings / auth check. Optional. */
  characterId?: string;
  /**
   * Documented `/v1/` inventory path. May include `{hashed_character_id}`.
   * Unset until copied from the in-game API settings page.
   */
  inventoryPath?: string;
}

export interface AuthCharacterRef {
  hashedId?: string;
  name?: string;
  totalLevel?: number;
}

export interface AuthCheck {
  authenticated: boolean;
  character?: AuthCharacterRef;
  apiKeyName?: string;
  rateLimit?: number;
  scopes?: string[] | null;
}

export interface CharacterInformation {
  name?: string;
  hashedId?: string;
  gold?: number;
  tokens?: number;
  totalLevel?: number;
  combatLevel?: number;
  location?: string;
  skillLevels: Partial<Record<SkillId, number>>;
  /** Null when the payload has no inventory collection. */
  inventory: Record<string, number> | null;
}

export interface PublicApiRead {
  characterName?: string;
  /** Null when no documented inventory payload or path was available. */
  inventory: Record<string, number> | null;
  skillLevels: Partial<Record<SkillId, number>>;
  gold?: number;
  tokens?: number;
  totalLevel?: number;
  combatLevel?: number;
  location?: string;
  currentAction?: CurrentActionInfo;
  skipped?: 'name_mismatch';
}

export interface IdleMmoClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: IdleMmoClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function isSafeV1Path(path: string): boolean {
  if (!path.startsWith('/v1/')) return false;
  if (path.includes('..') || path.includes('://') || path.includes('\\')) return false;
  if (path.includes('?') || path.includes('#') || path.includes(' ')) return false;
  return /^\/v1\/[A-Za-z0-9_./{}-]+$/.test(path);
}

export function canonicalInventoryKey(name: string): string {
  const matched = matchKnownItem(name) ?? name.trim();
  return ALIAS_TO_CANONICAL[matched] ?? matched;
}

export function loadIdleMmoApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdleMmoApiConfig | null {
  const apiKey = env.IDLE_MMO_API_KEY?.trim();
  if (!apiKey) return null;

  let baseUrl = (env.IDLE_MMO_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
  baseUrl = baseUrl.replace(/\/v1$/, '');

  const inventoryPath = env.IDLE_MMO_INVENTORY_PATH?.trim() || undefined;
  if (inventoryPath && !isSafeV1Path(inventoryPath)) {
    throw new IdleMmoApiError(
      'IDLE_MMO_INVENTORY_PATH must be a documented /v1/ path from in-game API settings',
      'bad_response',
    );
  }

  const minIntervalMs = positiveInt(env.IDLE_MMO_API_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS);
  const cacheTtlMs = positiveInt(env.IDLE_MMO_API_CACHE_MS, DEFAULT_CACHE_TTL_MS);
  const characterId = env.IDLE_MMO_CHARACTER_ID?.trim() || undefined;
  if (characterId && !/^[\w-]+$/.test(characterId)) {
    throw new IdleMmoApiError('IDLE_MMO_CHARACTER_ID has unexpected characters', 'bad_response');
  }

  return {
    apiKey,
    baseUrl,
    userAgent: IDLE_MMO_BOT_USER_AGENT,
    minIntervalMs,
    cacheTtlMs,
    characterId,
    inventoryPath,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function skillFromText(value: string | undefined): SkillId | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  return SKILL_IDS.find((skill) => skill.replace(/[\s_-]+/g, '') === normalized);
}

export function parseAuthCheck(body: unknown): AuthCheck {
  const root = asRecord(body);
  if (!root) {
    throw new IdleMmoApiError('Auth check response was not an object', 'bad_response');
  }
  const character = asRecord(root.character);
  const apiKey = asRecord(root.api_key);
  const scopesRaw = apiKey?.scopes;
  const scopes = Array.isArray(scopesRaw)
    ? scopesRaw.filter((scope): scope is string => typeof scope === 'string')
    : scopesRaw === null
      ? null
      : undefined;

  return {
    authenticated: root.authenticated === true,
    character: character
      ? {
          hashedId: asString(character.hashed_id),
          name: asString(character.name),
          totalLevel: asNumber(character.total_level),
        }
      : undefined,
    apiKeyName: asString(apiKey?.name),
    rateLimit: asNumber(apiKey?.rate_limit),
    scopes,
  };
}

export function parseCharacterInformation(body: unknown): CharacterInformation {
  const root = asRecord(body);
  const character = asRecord(root?.character) ?? root;
  if (!character) {
    throw new IdleMmoApiError('Character information response was not an object', 'bad_response');
  }

  const skillLevels: Partial<Record<SkillId, number>> = {};
  const skills = asRecord(character.skills);
  if (skills) {
    for (const [key, value] of Object.entries(skills)) {
      const skill = skillFromText(key);
      if (!skill) continue;
      const record = asRecord(value);
      const level = asNumber(record?.level ?? value);
      if (level !== undefined) skillLevels[skill] = level;
    }
  }

  let combatLevel = asNumber(character.combat_level);
  const combatSkill = asRecord(skills?.combat);
  if (combatLevel === undefined) combatLevel = asNumber(combatSkill?.level);
  const stats = asRecord(character.stats);
  const combatStat = asRecord(stats?.combat);
  if (combatLevel === undefined) combatLevel = asNumber(combatStat?.level);

  const locationRecord = asRecord(character.location);
  const location = asString(locationRecord?.name) ?? asString(character.location);

  return {
    name: asString(character.name),
    hashedId: asString(character.hashed_id),
    gold: asNumber(character.gold),
    tokens: asNumber(character.tokens),
    totalLevel: asNumber(character.total_level),
    combatLevel,
    location,
    skillLevels,
    inventory: inventoryFromCharacterPayload(character, root),
  };
}

function inventoryFromCharacterPayload(
  character: Record<string, unknown>,
  root: Record<string, unknown> | null,
): Record<string, number> | null {
  if (
    'inventory' in character ||
    'items' in character ||
    'inventory_items' in character
  ) {
    return inventoryQuantitiesFromUnknown(character);
  }
  if (root && root !== character && ('inventory' in root || 'items' in root)) {
    return inventoryQuantitiesFromUnknown(root);
  }
  return null;
}

export function parseCurrentAction(body: unknown): CurrentActionInfo | undefined {
  if (body == null) return undefined;
  const root = asRecord(body);
  if (!root) return undefined;
  const nested = asRecord(root.current_action) ?? asRecord(root.action);
  const action = nested ?? root;
  if ('current_action' in root && root.current_action == null && !nested) return undefined;
  if ('action' in root && root.action == null && !nested) return undefined;

  const type = asString(action.type);
  const item = asString(action.item);
  const title = asString(action.title);
  if (!type && !item && !title) return undefined;

  const produced = asNumber(action.produced_count ?? action.produced);
  return {
    busy: true,
    skill: skillFromText(type) ?? skillFromText(title),
    resource: item,
    label: title || type || item,
    producedCount: produced !== undefined && produced >= 0 ? produced : undefined,
  };
}

/** Parse an inventory collection. Null when the shape is not a known item list. */
export function inventoryQuantitiesFromUnknown(
  payload: unknown,
): Record<string, number> | null {
  const items = findItemArray(payload, 0);
  if (!items) return null;
  if (items.length === 0) return {};

  const out: Record<string, number> = {};
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const nested = asRecord(record.item);
    const name =
      asString(record.name) ??
      asString(record.item_name) ??
      asString(nested?.name);
    const qty = readQuantity(record.quantity ?? record.qty ?? record.amount ?? record.stack);
    if (!name || qty === undefined) continue;
    const key = canonicalInventoryKey(name);
    out[key] = Math.max(out[key] ?? 0, qty);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function readQuantity(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = parseQuantityString(value);
    if (value.trim() && (parsed > 0 || value.trim() === '0')) return parsed;
  }
  return undefined;
}

function findItemArray(payload: unknown, depth: number): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (depth > 2) return null;
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of ['items', 'inventory', 'inventory_items', 'data', 'character'] as const) {
    if (!(key in record)) continue;
    const found = findItemArray(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function fillCharacterPath(path: string, hashedId: string): string {
  if (!/^[\w-]+$/.test(hashedId)) {
    throw new IdleMmoApiError('Refusing character id with unexpected characters', 'bad_response');
  }
  return path.replaceAll('{hashed_character_id}', encodeURIComponent(hashedId));
}

export class IdleMmoApiClient {
  private readonly cache = new Map<string, { expiresAt: number; value?: unknown; empty?: boolean }>();
  private nextAt = 0;
  private tail: Promise<void> = Promise.resolve();
  private blockedUntil = 0;
  private loggedInventoryGap = false;

  constructor(
    private readonly config: IdleMmoApiConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly clock: IdleMmoClock = systemClock,
  ) {}

  async checkAuth(): Promise<AuthCheck> {
    const body = await this.request(DOCUMENTED_PATHS.authCheck, AUTH_CACHE_TTL_MS);
    return parseAuthCheck(body);
  }

  async getCharacterInformation(hashedCharacterId: string): Promise<CharacterInformation | null> {
    const path = fillCharacterPath(DOCUMENTED_PATHS.characterInformation, hashedCharacterId);
    const body = await this.request(path, this.config.cacheTtlMs, { notFound: 'empty' });
    if (body === undefined) return null;
    return parseCharacterInformation(body);
  }

  async getCurrentAction(hashedCharacterId: string): Promise<CurrentActionInfo | undefined> {
    const path = fillCharacterPath(DOCUMENTED_PATHS.currentAction, hashedCharacterId);
    const body = await this.request(path, this.config.cacheTtlMs, { notFound: 'empty' });
    if (body === undefined) return undefined;
    return parseCurrentAction(body);
  }

  /**
   * Fetch inventory only when `IDLE_MMO_INVENTORY_PATH` is a safe `/v1/` path.
   * Returns null (no request) when the path is unset.
   */
  async getInventory(hashedCharacterId: string): Promise<Record<string, number> | null> {
    const template = this.config.inventoryPath;
    if (!template) return null;
    if (!isSafeV1Path(template)) {
      throw new IdleMmoApiError('Refusing inventory path outside /v1/', 'bad_response');
    }
    const path = fillCharacterPath(template, hashedCharacterId);
    if (!isSafeV1Path(path)) {
      throw new IdleMmoApiError('Refusing expanded inventory path outside /v1/', 'bad_response');
    }
    const body = await this.request(path, this.config.cacheTtlMs, { notFound: 'empty' });
    if (body === undefined) return null;
    return inventoryQuantitiesFromUnknown(body);
  }

  /**
   * Auth + character + current action, plus inventory when a documented path is set
   * or the character payload already includes an item list.
   * Null when the API key is missing (caller keeps the DOM scrape).
   */
  async readSnapshot(expectedCharacterName?: string): Promise<PublicApiRead | null> {
    if (!this.config.apiKey) {
      throw new IdleMmoApiError('IDLE_MMO_API_KEY is not set', 'missing_key');
    }

    const auth = await this.checkAuth();
    const hashedId = this.config.characterId || auth.character?.hashedId;
    const authName = auth.character?.name;
    if (
      expectedCharacterName &&
      authName &&
      expectedCharacterName.toLowerCase() !== authName.toLowerCase()
    ) {
      return {
        characterName: authName,
        inventory: null,
        skillLevels: {},
        skipped: 'name_mismatch',
      };
    }

    if (!hashedId) {
      return { characterName: authName, inventory: null, skillLevels: {} };
    }

    const character = await this.getCharacterInformation(hashedId);
    const characterName = character?.name ?? authName;
    if (
      expectedCharacterName &&
      characterName &&
      expectedCharacterName.toLowerCase() !== characterName.toLowerCase()
    ) {
      return {
        characterName,
        inventory: null,
        skillLevels: {},
        skipped: 'name_mismatch',
      };
    }

    const currentAction = await this.getCurrentAction(hashedId);
    let inventory = character?.inventory ?? null;
    if (inventory === null && this.config.inventoryPath) {
      inventory = await this.getInventory(hashedId);
      if (inventory === null && !this.loggedInventoryGap) {
        this.loggedInventoryGap = true;
        console.log(
          '[snapshot] API inventory response unrecognized or missing — DOM quantities kept',
        );
      }
    } else if (inventory === null && !this.loggedInventoryGap) {
      this.loggedInventoryGap = true;
      console.log(
        '[snapshot] API inventory path unset — DOM quantities kept until IDLE_MMO_INVENTORY_PATH is set from API settings',
      );
    }

    return {
      characterName,
      inventory,
      skillLevels: character?.skillLevels ?? {},
      gold: character?.gold,
      tokens: character?.tokens,
      totalLevel: character?.totalLevel ?? auth.character?.totalLevel,
      combatLevel: character?.combatLevel,
      location: character?.location,
      currentAction,
    };
  }

  private async request(
    path: string,
    cacheTtlMs: number,
    options?: { notFound?: 'empty' },
  ): Promise<unknown> {
    if (!this.config.apiKey) {
      throw new IdleMmoApiError('IDLE_MMO_API_KEY is not set', 'missing_key');
    }
    if (!isSafeV1Path(path)) {
      throw new IdleMmoApiError('Refusing request outside documented /v1/ paths', 'bad_response');
    }

    const now = this.clock.now();
    const cached = this.cache.get(path);
    if (cached && cached.expiresAt > now) {
      if (cached.empty) return undefined;
      return cached.value;
    }
    if (now < this.blockedUntil) {
      throw new IdleMmoApiError(
        'IdleMMO API is in backoff after 401/429 — DOM scrape kept',
        'rate_limited',
      );
    }

    await this.acquire();

    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: 'application/json',
        'User-Agent': this.config.userAgent,
      },
    });
    this.noteRateHeaders(response);

    if (response.status === 401) {
      this.blockedUntil = this.clock.now() + FAILURE_BACKOFF_MS;
      throw new IdleMmoApiError(
        'IdleMMO API unauthorized (401). Check IDLE_MMO_API_KEY.',
        'unauthorized',
        401,
      );
    }
    if (response.status === 403) {
      throw new IdleMmoApiError(
        'IdleMMO API forbidden (403). Check API key scopes.',
        'forbidden',
        403,
      );
    }
    if (response.status === 429) {
      this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + FAILURE_BACKOFF_MS);
      throw new IdleMmoApiError('IdleMMO API rate limited (429). Backing off.', 'rate_limited', 429);
    }
    if (response.status === 404 && options?.notFound === 'empty') {
      this.cache.set(path, { expiresAt: this.clock.now() + cacheTtlMs, empty: true });
      return undefined;
    }
    if (!response.ok) {
      throw new IdleMmoApiError(`IdleMMO API HTTP ${response.status}`, 'http', response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new IdleMmoApiError('IdleMMO API returned non-JSON', 'bad_response', response.status);
    }
    this.cache.set(path, { expiresAt: this.clock.now() + cacheTtlMs, value: body });
    return body;
  }

  private noteRateHeaders(response: Response): void {
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const resetSec = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetSec)) {
      const resetMs = resetSec > 10_000_000_000 ? resetSec : resetSec * 1000;
      this.blockedUntil = Math.max(this.blockedUntil, resetMs);
      this.nextAt = Math.max(this.nextAt, resetMs);
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        const until = this.clock.now() + retryAfter * 1000;
        this.nextAt = Math.max(this.nextAt, until);
        this.blockedUntil = Math.max(this.blockedUntil, until);
      }
    }
  }

  private async acquire(): Promise<void> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const wait = this.nextAt - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.nextAt = this.clock.now() + this.config.minIntervalMs;
    } finally {
      release();
    }
  }
}

let singleton: IdleMmoApiClient | null = null;
let singletonFingerprint = '';

export function getIdleMmoApiClient(
  env: NodeJS.ProcessEnv = process.env,
): IdleMmoApiClient | null {
  const config = loadIdleMmoApiConfig(env);
  if (!config) {
    singleton = null;
    singletonFingerprint = '';
    return null;
  }
  const fingerprint = [
    config.baseUrl,
    config.cacheTtlMs,
    config.minIntervalMs,
    config.inventoryPath ?? '',
    config.characterId ?? '',
    config.apiKey,
  ].join('|');
  if (!singleton || singletonFingerprint !== fingerprint) {
    singleton = new IdleMmoApiClient(config);
    singletonFingerprint = fingerprint;
  }
  return singleton;
}

/** Test hook — drop the process-wide client. */
export function resetIdleMmoApiClientForTests(): void {
  singleton = null;
  singletonFingerprint = '';
}
