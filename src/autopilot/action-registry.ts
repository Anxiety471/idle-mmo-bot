import type { AppConfig } from '../config.js';
import type { ActionAllowContext, ActionDefinition, ActionExecuteContext, AutopilotActionId } from './action-types.js';
import type { AutopilotContext, GameSnapshot, ActionResult } from '../types.js';
import { filterAllowedByPlaybook, getPlaybookFromSnapshot } from './early-systems-playbook.js';

const registry = new Map<AutopilotActionId, ActionDefinition>();

/** Register a scriptable autopilot action. Later registrations override same id. */
export function registerAction(def: ActionDefinition): void {
  registry.set(def.id, def);
}

export function getAction(id: AutopilotActionId): ActionDefinition | undefined {
  return registry.get(id);
}

export function listActions(): ActionDefinition[] {
  return [...registry.values()];
}

export function listBootstrapActions(): ActionDefinition[] {
  return listActions().filter((a) => a.bootstrap);
}

export function describeActions(ids: AutopilotActionId[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const def = registry.get(id);
    out[id] = def?.description ?? `Action ${id}`;
  }
  return out;
}

/** Derive all currently allowed actions from registered definitions + snapshot. */
export function deriveAllowedActions(
  snapshot: GameSnapshot,
  config: AppConfig,
  junkItems: string[],
  context: AutopilotContext,
): AutopilotActionId[] {
  const allowCtx: ActionAllowContext = { snapshot, config, junkItems, context };
  const allowed: AutopilotActionId[] = [];

  for (const def of registry.values()) {
    try {
      if (def.isAllowed(allowCtx)) {
        allowed.push(def.id);
      }
    } catch {
      // Skip broken action modules rather than crash the supervisor loop.
    }
  }

  if (allowed.length === 0) {
    return registry.has('idle') ? ['idle'] : [];
  }

  const playbook = getPlaybookFromSnapshot(snapshot);
  const filtered = playbook ? filterAllowedByPlaybook(allowed, snapshot, playbook) : allowed;
  return applyHuntSwitch(filtered, allowed);
}

/** Actions that start a hunt or Battle. HUNT_ENABLED=false removes them. */
export const HUNT_ACTIONS: readonly AutopilotActionId[] = ['hunt_battle', 'hunt_battle_batch', 'hunt_rabbits'];
const SPEND_ACTIONS: readonly AutopilotActionId[] = ['buy_bait', 'market_sell_half', 'sell_junk_for_gold', 'sell_junk'];

export function huntEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.HUNT_ENABLED?.trim() ?? '');
}

/**
 * Round 9: per-character hunting switch. With HUNT_ENABLED=false hunt/Battle actions are
 * dropped; while the playbook sits in a hunt stage its filter would leave little else, so
 * the non-hunt, non-spend actions the registry allowed (gather, fish, cook, continue) are
 * added back so the bot keeps gathering. Kill quests simply wait.
 */
export function applyHuntSwitch(
  filtered: AutopilotActionId[],
  raw: AutopilotActionId[],
  env: NodeJS.ProcessEnv = process.env,
): AutopilotActionId[] {
  if (huntEnabled(env)) return filtered;
  const out = filtered.filter((a) => !HUNT_ACTIONS.includes(a));
  for (const a of raw) {
    if (HUNT_ACTIONS.includes(a) || SPEND_ACTIONS.includes(a) || out.includes(a)) continue;
    out.push(a);
  }
  return out.length ? out : ['idle'];
}

export async function executeRegisteredAction(
  id: AutopilotActionId,
  ctx: ActionExecuteContext,
): Promise<ActionResult> {
  const def = registry.get(id);
  if (!def) {
    return { action: id, outcome: 'unregistered_action', backoffMs: ctx.config.pollMs * 2 };
  }
  return def.execute(ctx);
}
