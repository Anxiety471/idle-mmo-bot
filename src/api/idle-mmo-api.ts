import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { sanitizeForLog } from '../logging/sanitize.js';
import {
  documentedEndpoint,
  plannedRefreshRequests,
  resolveDocumentedPath,
  type DocumentedEndpoint,
  type PathIds,
} from './documented-endpoints.js';
import {
  applyCharacterInformation,
  applyMappedIdentity,
  collectCharacterRefs,
  mapCharacterInformation,
  mapCurrentActionPayload,
  mapIdentityPayload,
  mapLocationsPayload,
  mapPetsPayload,
  selectCharacterHashedId,
} from './map-public-api.js';
import type {
  PublicApiErrorInfo,
  PublicApiRead,
  PublicApiSnapshotPatch,
  UnavailableResource,
} from './public-api-types.js';
import { minSafeIntervalMs, PUBLIC_API_MAX_PER_MINUTE, SlidingWindowRateLimiter } from './rate-limit.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

export const PUBLIC_API_USER_AGENT = `idle-mmo-bot/${pkg.version} (Contact: local-overseer)`;

/** Origin from the in-game Public API settings page. Paths stay under `/v1`. */
export const DEFAULT_PUBLIC_API_ORIGIN = 'https://api.idle-mmo.com';

export type IdleMmoApiErrorCode =
  | 'missing-key'
  | 'missing-base'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'budget'
  | 'http'
  | 'network'
  | 'unpublished';

export class IdleMmoApiError extends Error {
  readonly code: IdleMmoApiErrorCode;
  readonly status?: number;

  constructor(code: IdleMmoApiErrorCode, message: string, status?: number) {
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
  guildId?: string;
  characterName?: string;
  /** Resolved from `IDLE_MMO_CHARACTER_HASHED_ID` when that value is a single path segment. */
  characterHashedId?: string;
  minIntervalMs: number;
  maxPerMinute: number;
}

export type IdleMmoApiConfigResult =
  | { enabled: false; reason: 'missing-key' }
  | { enabled: false; reason: 'missing-base'; message: string }
  | { enabled: true; config: IdleMmoApiConfig };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface IdleMmoApiDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
}

const MISSING_BASE_MESSAGE =
  'IDLE_MMO_API_BASE is set but invalid. Use an https origin only, or unset it to use https://api.idle-mmo.com. Playwright scrape kept.';

export function loadIdleMmoApiConfig(env: NodeJS.ProcessEnv = process.env): IdleMmoApiConfigResult {
  const apiKey = env.IDLE_MMO_API_KEY?.trim() ?? '';
  if (!apiKey) return { enabled: false, reason: 'missing-key' };

  const baseRaw = env.IDLE_MMO_API_BASE?.trim() || DEFAULT_PUBLIC_API_ORIGIN;

  let baseUrl: string;
  try {
    baseUrl = parseApiBaseUrl(baseRaw);
  } catch (error) {
    const message = error instanceof Error ? error.message : MISSING_BASE_MESSAGE;
    return { enabled: false, reason: 'missing-base', message };
  }

  const guildRaw = env.IDLE_MMO_GUILD_ID?.trim() || undefined;
  const guildId = guildRaw && /^[A-Za-z0-9_-]{1,128}$/.test(guildRaw) ? guildRaw : undefined;
  const characterRaw = env.IDLE_MMO_CHARACTER_HASHED_ID?.trim() || undefined;
  const characterHashedId =
    characterRaw && /^[A-Za-z0-9_-]{1,128}$/.test(characterRaw) ? characterRaw : undefined;
  const minIntervalMs = minSafeIntervalMs(
    plannedRefreshRequests(Boolean(characterHashedId)),
    PUBLIC_API_MAX_PER_MINUTE,
  );

  return {
    enabled: true,
    config: {
      apiKey,
      baseUrl,
      userAgent: PUBLIC_API_USER_AGENT,
      guildId,
      characterName: env.CHARACTER_NAME?.trim() || undefined,
      characterHashedId,
      minIntervalMs,
      maxPerMinute: PUBLIC_API_MAX_PER_MINUTE,
    },
  };
}

/** Origin only. Defaults to https://api.idle-mmo.com when the env override is unset. */
export function parseApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IdleMmoApiError(
      'missing-base',
      'IDLE_MMO_API_BASE is not a valid URL. Copy the host from the in-game API settings page.',
    );
  }
  if (url.protocol !== 'https:') {
    throw new IdleMmoApiError('missing-base', 'IDLE_MMO_API_BASE must be https.');
  }
  if (url.username || url.password) {
    throw new IdleMmoApiError('missing-base', 'IDLE_MMO_API_BASE must not include credentials.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new IdleMmoApiError(
      'missing-base',
      'IDLE_MMO_API_BASE must be the origin only (no path). Paths are limited to the documented /v1 catalog.',
    );
  }
  if (url.search || url.hash) {
    throw new IdleMmoApiError('missing-base', 'IDLE_MMO_API_BASE must not include a query or hash.');
  }
  return url.origin;
}

function redact(message: string, secret: string): string {
  let out = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out;
}

const CHARACTER_REFRESH_IDS = ['character-information', 'current-action', 'character-pets'] as const;

function missingCharacterResources(): UnavailableResource[] {
  return CHARACTER_REFRESH_IDS.map((id) => {
    const endpoint = documentedEndpoint(id);
    return {
      id: endpoint.id,
      role: endpoint.role,
      reason: 'missing-character-id' as const,
      snapshotFields: endpoint.snapshotFields,
      summary: endpoint.summary,
    };
  });
}

interface HttpResult {
  status: number;
  body?: unknown;
  rateLimitReset?: string;
}

export class IdleMmoPublicApi {
  private readonly limiter: SlidingWindowRateLimiter;
  private cache: { at: number; value: PublicApiRead } | null = null;
  private blockedUntil = 0;

  constructor(
    private readonly config: IdleMmoApiConfig,
    private readonly deps: IdleMmoApiDeps = {},
  ) {
    this.limiter = new SlidingWindowRateLimiter(config.maxPerMinute, deps.now ?? Date.now);
  }

  async read(): Promise<PublicApiRead> {
    const now = this.deps.now ?? Date.now;
    const current = now();
    if (this.cache && (current - this.cache.at < this.config.minIntervalMs || current < this.blockedUntil)) {
      return { ...this.cache.value, fromCache: true };
    }

    const patch: PublicApiSnapshotPatch = {};
    const errors: PublicApiErrorInfo[] = [];
    const endpointsUsed: string[] = [];
    const meta: Record<string, unknown> = {};
    const guildMeta: Record<string, unknown> = {};
    const unavailable: UnavailableResource[] = [];
    let stop = false;

    let characterId = this.config.characterHashedId;
    if (!characterId) {
      const resolved = await this.resolveCharacterId(
        current,
        patch,
        endpointsUsed,
        errors,
        meta,
        guildMeta,
      );
      characterId = resolved.characterId;
      stop = resolved.stop;
    }

    if (!stop && characterId) {
      applyMappedIdentity(patch, { hashedId: characterId, names: [] });
      for (const id of ['character-information', 'current-action'] as const) {
        const outcome = await this.fetchEndpoint(
          documentedEndpoint(id),
          { characterId },
          current,
          patch,
          endpointsUsed,
          errors,
          meta,
          guildMeta,
        );
        if (outcome === 'stop') {
          stop = true;
          break;
        }
        if (outcome === 'budget') {
          this.pushBudget(id, errors);
          stop = true;
          break;
        }
      }
    } else if (!stop) {
      errors.push({
        id: 'character-information',
        code: 'missing-character-id',
        message:
          'Character id unresolved. Set IDLE_MMO_CHARACTER_HASHED_ID or CHARACTER_NAME. Inventory stays on the Playwright scrape.',
      });
      unavailable.push(...missingCharacterResources());
    }

    if (!stop && characterId) {
      const pets = await this.fetchEndpoint(
        documentedEndpoint('character-pets'),
        { characterId },
        current,
        patch,
        endpointsUsed,
        errors,
        meta,
        guildMeta,
      );
      if (pets === 'budget') meta.petsSkipped = 'budget';
    }

    if (Object.keys(guildMeta).length > 0) meta.guild = guildMeta;
    if (patch.identity) {
      meta.identity = {
        hashedId: patch.identity.hashedId,
        onlineStatus: patch.identity.onlineStatus,
        names: patch.identity.names,
        currentStatus: patch.identity.currentStatus,
        matchesCharacter: this.identityMatches(patch.identity.names),
      };
    }

    const read: PublicApiRead = {
      ok: errors.length === 0 || endpointsUsed.length > 0,
      fromCache: false,
      fetchedAt: current,
      endpointsUsed,
      errors,
      unavailable,
      patch,
      meta,
    };
    this.cache = { at: current, value: read };
    return read;
  }

  private async resolveCharacterId(
    current: number,
    patch: PublicApiSnapshotPatch,
    endpointsUsed: string[],
    errors: PublicApiErrorInfo[],
    meta: Record<string, unknown>,
    guildMeta: Record<string, unknown>,
  ): Promise<{ characterId?: string; stop: boolean }> {
    const auth = await this.fetchEndpoint(
      documentedEndpoint('auth-check'),
      {},
      current,
      patch,
      endpointsUsed,
      errors,
      meta,
      guildMeta,
    );
    if (auth === 'stop') return { stop: true };
    if (auth === 'budget') {
      this.pushBudget('auth-check', errors);
      return { stop: true };
    }
    if (auth === 'error' || !auth.body) return { stop: false };

    const refs = collectCharacterRefs(auth.body);
    let characterId = selectCharacterHashedId(refs, this.config.characterName);
    if (characterId || !this.config.characterName) return { characterId, stop: false };

    const seed = refs.find((ref) => ref.hashedId)?.hashedId;
    if (!seed) return { stop: false };

    const alts = await this.fetchEndpoint(
      documentedEndpoint('character-characters'),
      { characterId: seed },
      current,
      patch,
      endpointsUsed,
      errors,
      meta,
      guildMeta,
    );
    if (alts === 'stop') return { stop: true };
    if (alts === 'budget') {
      this.pushBudget('character-characters', errors);
      return { stop: true };
    }
    if (alts === 'error' || !alts.body) return { stop: false };
    characterId = selectCharacterHashedId(
      [...refs, ...collectCharacterRefs(alts.body)],
      this.config.characterName,
    );
    return { characterId, stop: false };
  }

  private pushBudget(id: string, errors: PublicApiErrorInfo[]): void {
    errors.push({
      id,
      code: 'budget',
      message: 'Local Public API budget exhausted (20/min). Playwright scrape kept.',
    });
  }

  /** Test hook. Production snapshot reads always go through the cache. */
  resetCache(): void {
    this.cache = null;
    this.blockedUntil = 0;
    this.limiter.reset();
  }

  private identityMatches(names: string[] | undefined): boolean | undefined {
    const wanted = this.config.characterName;
    if (!wanted || !names || names.length === 0) return undefined;
    return names.some((name) => name.toLowerCase() === wanted.toLowerCase());
  }

  private async fetchEndpoint(
    endpoint: DocumentedEndpoint,
    ids: PathIds,
    current: number,
    patch: PublicApiSnapshotPatch,
    endpointsUsed: string[],
    errors: PublicApiErrorInfo[],
    meta: Record<string, unknown>,
    guildMeta: Record<string, unknown>,
  ): Promise<'stop' | 'budget' | 'error' | { body?: unknown }> {
    if (current < this.blockedUntil || !this.limiter.tryTake()) return 'budget';
    let path: string;
    try {
      path = resolveDocumentedPath(endpoint, ids);
    } catch (error) {
      errors.push({
        id: endpoint.id,
        code: 'unpublished',
        message: redact(error instanceof Error ? error.message : 'invalid path', this.config.apiKey),
      });
      return 'error';
    }
    try {
      const result = await this.request(path);
      if (result.rateLimitReset) meta.rateLimitReset = result.rateLimitReset;
      endpointsUsed.push(endpoint.id);
      this.applyBody(endpoint, result.body, patch, guildMeta);
      if (endpoint.id === 'auth-check') meta.authOk = true;
      return { body: result.body };
    } catch (error) {
      const info = this.toErrorInfo(endpoint.id, error);
      errors.push(info);
      if (info.code === 'unauthorized' || info.code === 'rate-limited') return 'stop';
      return 'error';
    }
  }

  private applyBody(
    endpoint: DocumentedEndpoint,
    body: unknown,
    patch: PublicApiSnapshotPatch,
    guildMeta: Record<string, unknown>,
  ): void {
    if (endpoint.id === 'auth-check') {
      applyMappedIdentity(patch, mapIdentityPayload(body));
    }
    if (endpoint.id === 'character-information') {
      applyCharacterInformation(patch, mapCharacterInformation(body));
    }
    if (endpoint.id === 'current-action') {
      const action = mapCurrentActionPayload(body);
      if (action) patch.currentAction = action;
    }
    if (endpoint.id === 'character-pets') {
      const pets = mapPetsPayload(body);
      if (pets) patch.pets = pets;
    }
    if (endpoint.role === 'locations') {
      const locations = mapLocationsPayload(body);
      if (locations.zones.length > 0) patch.zones = locations.zones;
      if (locations.location) patch.location = locations.location;
      if (locations.weather) patch.weather = locations.weather;
    }
    if (endpoint.role === 'guild') {
      guildMeta[endpoint.id] = sanitizeForLog(body);
    }
  }

  private async request(path: string): Promise<HttpResult> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const url = `${this.config.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          'User-Agent': this.config.userAgent,
        },
      });
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : 'network failure',
        this.config.apiKey,
      );
      throw new IdleMmoApiError('network', `Public API request failed: ${message}`);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new IdleMmoApiError('http', `Public API redirect refused for ${path}`, response.status);
    }

    const rateLimitReset = response.headers.get('x-ratelimit-reset') ?? undefined;
    if (response.status === 401) {
      throw new IdleMmoApiError('unauthorized', 'Public API rejected the key (401).', 401);
    }
    if (response.status === 403) {
      throw new IdleMmoApiError('forbidden', `Public API forbidden for ${path} (403).`, 403);
    }
    if (response.status === 429) {
      this.noteRateLimit(rateLimitReset);
      throw new IdleMmoApiError('rate-limited', 'Public API rate limit reached (429).', 429);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new IdleMmoApiError('http', `Public API ${path} returned ${response.status}.`, response.status);
    }

    if (response.status === 204) return { status: response.status, rateLimitReset };
    const text = await response.text();
    if (!text.trim()) return { status: response.status, body: undefined, rateLimitReset };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown, rateLimitReset };
    } catch {
      throw new IdleMmoApiError('http', `Public API ${path} returned non-JSON.`, response.status);
    }
  }

  private noteRateLimit(resetHeader: string | undefined): void {
    const now = (this.deps.now ?? Date.now)();
    const parsed = parseRateLimitReset(resetHeader, now);
    this.blockedUntil = parsed ?? now + 60_000;
  }

  private toErrorInfo(id: string, error: unknown): PublicApiErrorInfo {
    if (error instanceof IdleMmoApiError) {
      return { id, code: error.code, message: error.message, status: error.status };
    }
    return {
      id,
      code: 'network',
      message: redact(error instanceof Error ? error.message : 'Public API request failed', this.config.apiKey),
    };
  }
}

export function parseRateLimitReset(header: string | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const numeric = Number(header);
  if (Number.isFinite(numeric)) {
    if (numeric >= 1e12) return numeric;
    if (numeric >= 1e9) return numeric * 1000;
    if (numeric > 0) return now + numeric * 1000;
    return undefined;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? date : undefined;
}

export function formatPublicApiLog(read: PublicApiRead, characterName?: string): string | undefined {
  if (read.fromCache) return undefined;

  if (read.endpointsUsed.length === 0 && read.errors.length > 0) {
    const code = read.errors[0]?.code ?? 'error';
    return `[snapshot] Public API failed (${code}); Playwright scrape kept`;
  }

  const used = read.endpointsUsed.join(', ') || 'none';
  const errorCodes = [...new Set(read.errors.map((error) => error.code))];
  let line = `[snapshot] Public API read ${used}; inventory remains Playwright scrape`;
  if (errorCodes.length > 0) line += `; errors=${errorCodes.join(',')}`;
  const identity = read.meta.identity as { matchesCharacter?: boolean } | undefined;
  if (characterName && identity?.matchesCharacter === false) {
    line += '; API identity does not include CHARACTER_NAME';
  }
  return line;
}

let singleton: { fingerprint: string; api: IdleMmoPublicApi } | null = null;
const loggedStatus = new Set<string>();

function fingerprint(config: IdleMmoApiConfig): string {
  const keyHash = createHash('sha256').update(config.apiKey).digest('hex').slice(0, 12);
  return `${config.baseUrl}|${config.guildId ?? ''}|${config.characterHashedId ?? ''}|${config.characterName ?? ''}|${config.minIntervalMs}|${keyHash}`;
}

export function resetPublicApiForTests(): void {
  singleton = null;
  loggedStatus.clear();
}

export async function readPublicApi(env: NodeJS.ProcessEnv = process.env): Promise<
  | { enabled: false; reason: 'missing-key' | 'missing-base'; message?: string }
  | { enabled: true; read: PublicApiRead }
> {
  const loaded = loadIdleMmoApiConfig(env);
  if (!loaded.enabled) return loaded;
  if (!singleton || singleton.fingerprint !== fingerprint(loaded.config)) {
    singleton = { fingerprint: fingerprint(loaded.config), api: new IdleMmoPublicApi(loaded.config) };
  }
  const read = await singleton.api.read();
  return { enabled: true, read };
}

/** Inventory lines log on every snapshot. Other status lines log once per distinct text. */
export function logPublicApiStatus(message: string | undefined, everyTime = false): void {
  if (!message) return;
  if (!everyTime) {
    if (loggedStatus.has(message)) return;
    loggedStatus.add(message);
  }
  console.log(message);
}
