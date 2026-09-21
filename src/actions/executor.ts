import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { ActionResult, AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';
import { executeRegisteredAction } from '../autopilot/action-registry.js';
import type { JevAdvisor } from '../jev/types.js';

/** Execute one registered supervisor action. */
export async function executeAction(
  action: AutopilotAction,
  page: Page,
  config: AppConfig,
  jev: JevAdvisor,
  options: {
    snapshot: GameSnapshot;
    forceInterrupt?: boolean;
    junkItems?: string[];
    context: AutopilotContext;
  },
): Promise<ActionResult> {
  return executeRegisteredAction(action, {
    page,
    config,
    jev,
    snapshot: options.snapshot,
    junkItems: options.junkItems ?? [],
    context: options.context,
    forceInterrupt: options.forceInterrupt ?? config.forceInterrupt,
  });
}
