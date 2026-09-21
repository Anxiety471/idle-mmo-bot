import type { AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';
import type { JevAdvisor } from './types.js';

/** Extended Jev interface for the progressive autopilot supervisor loop. */
export interface SupervisorAdvisor extends JevAdvisor {
  chooseNextAction(
    snapshot: GameSnapshot,
    allowed: AutopilotAction[],
    context: AutopilotContext,
  ): Promise<AutopilotAction>;
}
