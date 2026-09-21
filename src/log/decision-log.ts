import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionResult, AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';

const LOG_DIR = process.env.AUTOPILOT_LOG_DIR?.trim() || join(process.cwd(), 'logs');

function append(fileName: string, entry: Record<string, unknown>): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(join(LOG_DIR, fileName), `${line}\n`);
}

/** One JSON line per supervisor tick: snapshot + allowed + choice + outcome. */
export function logDecision(input: {
  snapshot: GameSnapshot;
  allowed: AutopilotAction[];
  action: AutopilotAction;
  result: ActionResult;
  context: AutopilotContext;
}): void {
  const { snapshot, allowed, action, result, context } = input;
  append('decisions.jsonl', {
    kind: 'decision',
    cycle: context.cycle,
    location: snapshot.location,
    pagePath: snapshot.pagePath,
    gold: snapshot.gold ?? null,
    tokens: snapshot.tokens ?? null,
    totalLevel: snapshot.totalLevel ?? null,
    combatLevel: snapshot.combatLevel ?? null,
    currentAction: snapshot.currentAction ?? null,
    skillLevels: snapshot.skillLevels,
    inventory: snapshot.inventory,
    acceptedQuests: snapshot.acceptedQuests,
    pendingQuests: snapshot.pendingQuests,
    combatPhase: snapshot.combatPhase,
    zones: snapshot.zones ?? [],
    discovered: snapshot.discovered ?? {},
    flags: snapshot.flags,
    playbook: snapshot.extensions?.earlySystemsPlaybook ?? null,
    lastAction: context.lastAction ?? null,
    gatherRotationIndex: context.gatherRotationIndex,
    allowed,
    action,
    outcome: result.outcome,
    backoffMs: result.backoffMs ?? null,
  });
}

/** Raw Jev / TypeSafe answers (no API token). Used later to tune criteria and thresholds. */
export function logJevCall(entry: Record<string, unknown>): void {
  append('jev.jsonl', { kind: 'jev', ...entry });
}
