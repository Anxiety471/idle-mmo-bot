import type { AutopilotAction } from '../types.js';
import { describeActions } from '../autopilot/action-registry.js';

/** Criteria map for HttpJev choice questions — pulls from registered action definitions. */
export function actionCriteria(allowed: AutopilotAction[]): Record<string, string> {
  return describeActions(allowed);
}
