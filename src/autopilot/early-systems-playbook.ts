/**
 * Early-systems playbook — curriculum / stage targets + allowed-action filters.
 *
 * HttpJev remains the decision brain. This module only:
 *  - tracks stage progress (coal → sell → bait → fish → cook → sell → hunt → map)
 *  - exposes preferred / deprioritized actions into the snapshot for Jev
 *  - filters allowed actions so endless Oak woodcutting loses priority until the run completes
 *
 * Hard constraints (huntFoundCap, no membership spend, gold Cheap Bait only) stay elsewhere.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogDir } from '../logging/jsonl-writer.js';
import type { AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';

export type EarlyStageId =
  | 'mine_coal'
  | 'sell_half'
  | 'buy_bait'
  | 'fish_cod'
  | 'cook_cod'
  | 'sell_extras'
  | 'hunt_rabbits'
  | 'explore_map'
  | 'complete';

export interface PlaybookCounts {
  coal: number;
  rawCod: number;
  cookedCod: number;
  sells: number;
  rabbitHunts: number;
  mapPeeks: number;
  /** Cycles observed while CURRENT ACTION was Coal (inventory often icon-only). */
  coalBusyCycles: number;
  codBusyCycles: number;
}

export interface PlaybookProgress {
  enabled: boolean;
  stage: EarlyStageId;
  stageIndex: number;
  stageGoal: string;
  preferredActions: AutopilotAction[];
  deprioritizedActions: AutopilotAction[];
  /** Actions that should be force-allowed even when gatherBusy (interrupt path). */
  interruptActions: AutopilotAction[];
  counts: PlaybookCounts;
  targets: {
    coalMin: number;
    coalMax: number;
    codMin: number;
    codMax: number;
  };
  curriculumHint: string;
  complete: boolean;
}

interface PersistedPlaybook {
  version: 1;
  stage: EarlyStageId;
  counts: PlaybookCounts;
  completedAt?: string;
}

const STAGE_ORDER: EarlyStageId[] = [
  'mine_coal',
  'sell_half',
  'buy_bait',
  'fish_cod',
  'cook_cod',
  'sell_extras',
  'hunt_rabbits',
  'explore_map',
  'complete',
];

const COAL_MIN = 30;
const COAL_MAX = 50;
const COD_MIN = 30;
const COD_MAX = 50;
/** Busy-cycle heuristic when inventory scrape is empty (~5s poll → ~2–3 cycles/ore). */
const COAL_BUSY_TARGET = 90;
const COD_BUSY_TARGET = 90;

/** Resolved at call time so AUTOPILOT_LOG_DIR is honored after env load. */
export function resolvePlaybookStatePath(): string {
  const override = process.env.PLAYBOOK_STATE_PATH?.trim();
  if (override) return override;
  return join(getLogDir(), 'playbook-state.json');
}

const GATHER_RESOURCE: Record<string, RegExp> = {
  mine_coal: /coal/i,
  fish_cod: /\bcod\b/i,
  cook_cod: /cook/i,
  gather_oak: /oak/i,
  gather_yew: /yew/i,
};

function emptyCounts(): PlaybookCounts {
  return {
    coal: 0,
    rawCod: 0,
    cookedCod: 0,
    sells: 0,
    rabbitHunts: 0,
    mapPeeks: 0,
    coalBusyCycles: 0,
    codBusyCycles: 0,
  };
}

function playbookEnabled(): boolean {
  const raw = process.env.EARLY_PLAYBOOK?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true; // on by default for IdleBocchi early run
}

function loadPersisted(): PersistedPlaybook {
  try {
    const statePath = resolvePlaybookStatePath();
    if (!existsSync(statePath)) {
      return { version: 1, stage: 'mine_coal', counts: emptyCounts() };
    }
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as PersistedPlaybook;
    if (parsed?.version !== 1 || !parsed.stage) {
      return { version: 1, stage: 'mine_coal', counts: emptyCounts() };
    }
    return {
      version: 1,
      stage: parsed.stage,
      counts: { ...emptyCounts(), ...parsed.counts },
      completedAt: parsed.completedAt,
    };
  } catch {
    return { version: 1, stage: 'mine_coal', counts: emptyCounts() };
  }
}

function savePersisted(state: PersistedPlaybook): void {
  try {
    const statePath = resolvePlaybookStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[playbook] failed to persist state: ${message}`);
  }
}

function invCount(snapshot: GameSnapshot, names: string[]): number {
  let max = 0;
  for (const name of names) {
    max = Math.max(max, snapshot.inventory[name] ?? 0);
  }
  // Exact / word-boundary fuzzy keys so "Cod" does not match "Code of Conduct".
  for (const [key, qty] of Object.entries(snapshot.inventory)) {
    const keyLower = key.toLowerCase();
    for (const n of names) {
      const nLower = n.toLowerCase();
      if (keyLower === nLower) {
        max = Math.max(max, qty);
        continue;
      }
      const escaped = nLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`);
      if (re.test(keyLower)) max = Math.max(max, qty);
    }
  }
  return max;
}

function syncCountsFromSnapshot(counts: PlaybookCounts, snapshot: GameSnapshot): PlaybookCounts {
  const next = { ...counts };
  const coal = invCount(snapshot, ['Coal Ore', 'Coal']);
  const rawCod = invCount(snapshot, ['Cod', 'Raw Cod']);
  const cooked = invCount(snapshot, ['Cooked Cod']);
  if (coal > 0) next.coal = Math.max(next.coal, coal);
  if (rawCod > 0) next.rawCod = Math.max(next.rawCod, rawCod);
  if (cooked > 0) next.cookedCod = Math.max(next.cookedCod, cooked);

  const resource = snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '';
  if (/coal/i.test(resource)) next.coalBusyCycles += 1;
  if (/\bcod\b/i.test(resource) && snapshot.currentAction?.skill === 'fishing') {
    next.codBusyCycles += 1;
  }
  return next;
}

function effectiveCoal(counts: PlaybookCounts): number {
  if (counts.coal >= COAL_MIN) return counts.coal;
  // Heuristic: ~1 ore per 2–3 busy cycles; clamp to COAL_MAX
  const estimate = Math.floor(counts.coalBusyCycles / 2.5);
  return Math.max(counts.coal, Math.min(COAL_MAX, estimate));
}

function effectiveCod(counts: PlaybookCounts): number {
  if (counts.rawCod >= COD_MIN) return counts.rawCod;
  const estimate = Math.floor(counts.codBusyCycles / 2.5);
  return Math.max(counts.rawCod, Math.min(COD_MAX, estimate));
}

function deriveStage(counts: PlaybookCounts, snapshot: GameSnapshot, persisted: EarlyStageId): EarlyStageId {
  if (persisted === 'complete') return 'complete';

  const coal = effectiveCoal(counts);
  const rawCod = effectiveCod(counts);
  const cooked = counts.cookedCod;
  const hasBait = snapshot.flags.hasBait || invCount(snapshot, ['Cheap Bait', 'Bait']) > 0;

  // Advance monotonically through STAGE_ORDER based on targets.
  const idx = STAGE_ORDER.indexOf(persisted);
  const atLeast = (stage: EarlyStageId): boolean => STAGE_ORDER.indexOf(stage) <= idx;

  if (coal < COAL_MIN && counts.coalBusyCycles < COAL_BUSY_TARGET) {
    return 'mine_coal';
  }
  if (counts.sells < 1 && atLeast('sell_half')) {
    // After coal target, require one careful sell pass before bait.
    if (persisted === 'mine_coal' || persisted === 'sell_half') return 'sell_half';
  }
  if (!hasBait && (persisted === 'sell_half' || persisted === 'buy_bait' || idx <= STAGE_ORDER.indexOf('buy_bait'))) {
    if (coal >= COAL_MIN || counts.coalBusyCycles >= COAL_BUSY_TARGET || counts.sells >= 1) {
      return 'buy_bait';
    }
  }
  if (hasBait && rawCod < COD_MIN && counts.codBusyCycles < COD_BUSY_TARGET) {
    if (idx >= STAGE_ORDER.indexOf('buy_bait') || hasBait) return 'fish_cod';
  }
  if (rawCod >= Math.floor(COD_MIN / 2) && cooked < Math.floor(COD_MIN / 2)) {
    if (idx >= STAGE_ORDER.indexOf('fish_cod')) return 'cook_cod';
  }
  if (cooked >= 5 && counts.sells < 2 && idx >= STAGE_ORDER.indexOf('cook_cod')) {
    return 'sell_extras';
  }
  if (cooked >= 3 && counts.rabbitHunts < 2 && idx >= STAGE_ORDER.indexOf('sell_extras')) {
    return 'hunt_rabbits';
  }
  if (counts.mapPeeks < 1 && idx >= STAGE_ORDER.indexOf('hunt_rabbits')) {
    return 'explore_map';
  }
  if (counts.mapPeeks >= 1 && counts.rabbitHunts >= 1) return 'complete';

  // Fall through: keep persisted stage if still sensible.
  return persisted === 'mine_coal' && coal >= COAL_MIN ? 'sell_half' : persisted;
}

function stageMeta(stage: EarlyStageId): {
  goal: string;
  preferred: AutopilotAction[];
  deprioritized: AutopilotAction[];
  interrupt: AutopilotAction[];
  hint: string;
} {
  switch (stage) {
    case 'mine_coal':
      return {
        goal: `Mine ${COAL_MIN}–${COAL_MAX} Coal Ore`,
        preferred: ['mine_coal', 'continue_current'],
        deprioritized: ['gather_oak', 'gather_yew', 'hunt_battle', 'explore_map'],
        interrupt: ['mine_coal'],
        hint:
          'EARLY PLAYBOOK stage mine_coal: interrupt Oak/Yew woodcutting and mine Coal Ore until ~30–50. Prefer mine_coal over continue_current when current resource is not Coal.',
      };
    case 'sell_half':
      return {
        goal: 'Sell roughly half the coal / junk carefully (small batches; keep cook fuel)',
        preferred: ['market_sell_half', 'sell_junk'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal'],
        interrupt: ['market_sell_half', 'sell_junk'],
        hint:
          'EARLY PLAYBOOK stage sell_half: sell ~half excess mats in small batches. Keep enough Coal for cooking. Do not membership-spend. Prefer market_sell_half.',
      };
    case 'buy_bait':
      return {
        goal: 'Buy Cheap Bait at Melriel General Goods (gold only)',
        preferred: ['buy_bait'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal'],
        interrupt: ['buy_bait'],
        hint: 'EARLY PLAYBOOK stage buy_bait: buy Cheap Bait with gold only (Purchase for N). No tokens/membership.',
      };
    case 'fish_cod':
      return {
        goal: `Fish ${COD_MIN}–${COD_MAX} Raw Cod`,
        preferred: ['fish_cod', 'continue_current', 'buy_bait'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal'],
        interrupt: ['fish_cod'],
        hint:
          'EARLY PLAYBOOK stage fish_cod: fish Cod. If current gather is not Cod, prefer fish_cod over continue_current. Buy bait if missing.',
      };
    case 'cook_cod':
      return {
        goal: 'Cook roughly half the Cod into Cooked Cod (battle food)',
        preferred: ['cook_cod'],
        deprioritized: ['gather_oak', 'gather_yew'],
        interrupt: ['cook_cod'],
        hint: 'EARLY PLAYBOOK stage cook_cod: cook Cod with Coal into Cooked Cod for battles.',
      };
    case 'sell_extras':
      return {
        goal: 'Sell extras carefully; keep Cod/Cooked Cod for battles',
        preferred: ['market_sell_half', 'sell_junk'],
        deprioritized: ['gather_oak', 'gather_yew'],
        interrupt: ['market_sell_half', 'sell_junk'],
        hint:
          'EARLY PLAYBOOK stage sell_extras: sell junk/extras in small batches. Never sell all Cooked Cod / Cod needed for fights.',
      };
    case 'hunt_rabbits':
      return {
        goal: 'Hunt Rabbits + battle using Cooked Cod (pre-battle FOOD Add)',
        preferred: ['hunt_rabbits', 'hunt_battle'],
        deprioritized: ['gather_oak', 'gather_yew', 'mine_coal'],
        interrupt: ['hunt_rabbits', 'hunt_battle'],
        hint:
          'EARLY PLAYBOOK stage hunt_rabbits: hunt and battle Rabbits. Ensure Cooked Cod is selected via FOOD Add before battle. Respect huntFoundCap.',
      };
    case 'explore_map':
      return {
        goal: 'Peek / explore the Map and register discovery',
        preferred: ['explore_map'],
        deprioritized: ['gather_oak', 'gather_yew'],
        interrupt: ['explore_map'],
        hint: 'EARLY PLAYBOOK stage explore_map: open the map, peek zones, register discovery. Read-only exploration.',
      };
    case 'complete':
    default:
      return {
        goal: 'Early systems playbook complete — resume progressive forever loop',
        preferred: [],
        deprioritized: [],
        interrupt: [],
        hint: 'EARLY PLAYBOOK complete. Expand actions via discovery; Jev chooses freely among progressive loops.',
      };
  }
}

/** Build playbook progress for this tick; persists stage counters. */
export function evaluatePlaybook(
  snapshot: GameSnapshot,
  _context?: AutopilotContext,
): PlaybookProgress {
  const enabled = playbookEnabled();
  if (!enabled) {
    return {
      enabled: false,
      stage: 'complete',
      stageIndex: STAGE_ORDER.indexOf('complete'),
      stageGoal: 'disabled',
      preferredActions: [],
      deprioritizedActions: [],
      interruptActions: [],
      counts: emptyCounts(),
      targets: { coalMin: COAL_MIN, coalMax: COAL_MAX, codMin: COD_MIN, codMax: COD_MAX },
      curriculumHint: 'Early playbook disabled (EARLY_PLAYBOOK=false).',
      complete: true,
    };
  }

  const persisted = loadPersisted();
  const counts = syncCountsFromSnapshot(persisted.counts, snapshot);
  let stage = deriveStage(counts, snapshot, persisted.stage);

  // Monotonic advance: never go backwards in STAGE_ORDER.
  const prevIdx = STAGE_ORDER.indexOf(persisted.stage);
  const nextIdx = STAGE_ORDER.indexOf(stage);
  if (nextIdx < prevIdx) stage = persisted.stage;

  // Auto-advance mine_coal → sell_half when coal target met.
  if (stage === 'mine_coal' && (effectiveCoal(counts) >= COAL_MIN || counts.coalBusyCycles >= COAL_BUSY_TARGET)) {
    stage = 'sell_half';
  }
  if (stage === 'sell_half' && counts.sells >= 1) stage = 'buy_bait';
  if (stage === 'buy_bait' && (snapshot.flags.hasBait || invCount(snapshot, ['Cheap Bait']) > 0)) {
    stage = 'fish_cod';
  }
  if (stage === 'fish_cod' && (effectiveCod(counts) >= COD_MIN || counts.codBusyCycles >= COD_BUSY_TARGET)) {
    stage = 'cook_cod';
  }
  if (stage === 'cook_cod' && counts.cookedCod >= Math.floor(COD_MIN / 2)) stage = 'sell_extras';
  if (stage === 'sell_extras' && counts.sells >= 2) stage = 'hunt_rabbits';
  if (stage === 'hunt_rabbits' && counts.rabbitHunts >= 2) stage = 'explore_map';
  if (stage === 'explore_map' && counts.mapPeeks >= 1) stage = 'complete';

  const meta = stageMeta(stage);
  const complete = stage === 'complete';

  savePersisted({
    version: 1,
    stage,
    counts,
    completedAt: complete ? persisted.completedAt ?? new Date().toISOString() : undefined,
  });

  return {
    enabled: true,
    stage,
    stageIndex: STAGE_ORDER.indexOf(stage),
    stageGoal: meta.goal,
    preferredActions: meta.preferred,
    deprioritizedActions: meta.deprioritized,
    interruptActions: meta.interrupt,
    counts,
    targets: { coalMin: COAL_MIN, coalMax: COAL_MAX, codMin: COD_MIN, codMax: COD_MAX },
    curriculumHint: meta.hint,
    complete,
  };
}

/** Record action outcomes that advance counters (sells, hunts, map peeks). */
export function notePlaybookOutcome(action: AutopilotAction, outcome: string): void {
  if (!playbookEnabled()) return;
  const persisted = loadPersisted();
  const counts = { ...persisted.counts };
  let stage = persisted.stage;

  if (action === 'market_sell_half' || action === 'sell_junk') {
    if (/sold|sell/i.test(outcome) && !/no_action|failed/i.test(outcome)) {
      counts.sells += 1;
    }
  }
  if (action === 'hunt_rabbits' || action === 'hunt_battle') {
    if (/battle:|hunt_started|enemy_selected/i.test(outcome)) {
      counts.rabbitHunts += 1;
    }
  }
  if (action === 'explore_map') {
    if (!/failed/i.test(outcome)) counts.mapPeeks += 1;
  }
  if (action === 'buy_bait' && /purchased/i.test(outcome)) {
    if (stage === 'buy_bait') stage = 'fish_cod';
  }
  if (action === 'cook_cod' && /restarted|already_busy|kept_current/i.test(outcome)) {
    counts.cookedCod = Math.max(counts.cookedCod, counts.cookedCod + 1);
  }
  if (action === 'mine_coal' && /restarted|already_busy/i.test(outcome)) {
    // Starting coal mining counts as leaving oak.
    if (stage === 'mine_coal') {
      /* stay */
    }
  }

  savePersisted({ version: 1, stage, counts });
}

/**
 * Filter/prioritize allowed actions using playbook curriculum.
 * Does NOT replace Jev — only shapes the choice set and hints.
 */
export function filterAllowedByPlaybook(
  allowed: AutopilotAction[],
  snapshot: GameSnapshot,
  playbook: PlaybookProgress,
): AutopilotAction[] {
  if (!playbook.enabled || playbook.complete) return allowed;

  const resource = snapshot.currentAction?.resource ?? snapshot.currentAction?.label ?? '';
  const busy = Boolean(snapshot.currentAction?.busy || snapshot.flags.gatherBusy);

  let next = allowed.filter((a) => !playbook.deprioritizedActions.includes(a));

  // While on a mismatched gather, drop continue_current so Jev can pick the stage action.
  const preferredGather = playbook.preferredActions.find((a) => GATHER_RESOURCE[a]);
  if (busy && preferredGather) {
    const want = GATHER_RESOURCE[preferredGather];
    const onPreferred = want?.test(resource) ?? false;
    if (!onPreferred) {
      next = next.filter((a) => a !== 'continue_current');
      for (const id of playbook.interruptActions) {
        if (!next.includes(id)) next.push(id);
      }
    }
  } else if (!busy) {
    for (const id of playbook.preferredActions) {
      if (!next.includes(id) && playbook.interruptActions.includes(id)) {
        // Preferred non-gather actions (sell/bait/map) get injected when not already allowed
        // only if they are in interrupt list — actual isAllowed still gated at registry for safety
        // except we already passed registry. Injecting here is for interrupt gathers mainly.
      }
    }
    for (const id of playbook.interruptActions) {
      if (!next.includes(id) && ['mine_coal', 'fish_cod', 'cook_cod', 'market_sell_half', 'explore_map', 'hunt_rabbits', 'buy_bait', 'sell_junk'].includes(id)) {
        next.push(id);
      }
    }
  }

  // Ensure idle remains available.
  if (!next.includes('idle') && allowed.includes('idle')) next.push('idle');
  if (next.length === 0) return allowed.includes('idle') ? ['idle'] : allowed;

  // Stable sort: preferred first, then original order.
  const preferred = new Set(playbook.preferredActions);
  next.sort((a, b) => {
    const ap = preferred.has(a) ? 0 : 1;
    const bp = preferred.has(b) ? 0 : 1;
    return ap - bp;
  });

  return next;
}

export function attachPlaybookToSnapshot(
  snapshot: GameSnapshot,
  playbook: PlaybookProgress,
): GameSnapshot {
  return {
    ...snapshot,
    extensions: {
      ...snapshot.extensions,
      earlySystemsPlaybook: playbook,
    },
  };
}

export function getPlaybookFromSnapshot(snapshot: GameSnapshot): PlaybookProgress | undefined {
  const raw = snapshot.extensions?.earlySystemsPlaybook;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as PlaybookProgress;
}

export function formatPlaybookLogLine(playbook: PlaybookProgress): string {
  const c = playbook.counts;
  return (
    `stage=${playbook.stage} goal="${playbook.stageGoal}"` +
    ` coal=${c.coal}/${playbook.targets.coalMin} (busyCycles=${c.coalBusyCycles})` +
    ` cod=${c.rawCod}/${playbook.targets.codMin} cooked=${c.cookedCod}` +
    ` sells=${c.sells} rabbits=${c.rabbitHunts} map=${c.mapPeeks}` +
    ` preferred=[${playbook.preferredActions.join(',')}]`
  );
}
