import type { AppConfig } from '../config.js';
import type { AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';
import { deriveAllowedActions as deriveFromRegistry } from '../autopilot/action-registry.js';

/** @deprecated Import deriveAllowedActions from action-registry after registerBootstrapActions(). */
export function deriveAllowedActions(
  snapshot: GameSnapshot,
  config: AppConfig,
  junkItems: string[],
  context?: AutopilotContext,
): AutopilotAction[] {
  const ctx: AutopilotContext = context ?? { cycle: 0, gatherRotationIndex: 0 };
  return deriveFromRegistry(snapshot, config, junkItems, ctx);
}

export function parseJunkSellItems(): string[] {
  const raw = process.env.JUNK_SELL_ITEMS?.trim();
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ['Burnt Cod', 'Burnt Fish', 'Burnt Salmon'];
}
