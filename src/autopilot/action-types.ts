import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { ActionResult, AutopilotContext, GameSnapshot } from '../types.js';
import type { JevAdvisor } from '../jev/types.js';

/** Open-ended action id — bootstrap actions are registered at startup; new loops add ids here. */
export type AutopilotActionId = string;

export interface ActionAllowContext {
  snapshot: GameSnapshot;
  config: AppConfig;
  junkItems: string[];
  context: AutopilotContext;
}

export interface ActionExecuteContext extends ActionAllowContext {
  page: Page;
  jev: JevAdvisor;
  forceInterrupt?: boolean;
}

export interface ActionDefinition {
  id: AutopilotActionId;
  description: string;
  /** Starter-pack action shipped with the bot. New loops omit this flag. */
  bootstrap?: boolean;
  /** Progressive stub preference (lower = sooner). */
  priority?: number;
  tags?: string[];
  /** Blocks real-money / membership flows. */
  safety: 'safe' | 'gold_spend' | 'inventory';
  isAllowed(ctx: ActionAllowContext): boolean;
  execute(ctx: ActionExecuteContext): Promise<ActionResult>;
}
