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
  if (playbook) {
    return filterAllowedByPlaybook(allowed, snapshot, playbook);
  }

  return allowed;
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
