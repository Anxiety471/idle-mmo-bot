import type { ActionResult, AutopilotAction, AutopilotContext, GameSnapshot } from '../types.js';
import { appendJsonl } from './jsonl-writer.js';

export interface DecisionLogRecord {
  timestamp: string;
  cycle: number;
  location: string;
  gold?: number;
  totalLevel?: number;
  combatLevel?: number;
  tokens?: number;
  currentAction?: GameSnapshot['currentAction'];
  inventory: Record<string, number>;
  acceptedQuests: GameSnapshot['acceptedQuests'];
  pendingQuests: GameSnapshot['pendingQuests'];
  combatPhase: GameSnapshot['combatPhase'];
  flags: GameSnapshot['flags'];
  discoveredUnregisteredRoutes?: string[];
  allowedActions: AutopilotAction[];
  chosenAction: AutopilotAction;
  executeOutcome: string;
  backoffMs?: number;
  gatherRotationIndex: number;
  lastAction?: AutopilotAction;
  playbook?: unknown;
}

export function buildDecisionRecord(
  snapshot: GameSnapshot,
  context: AutopilotContext,
  allowed: AutopilotAction[],
  chosenAction: AutopilotAction,
  result: ActionResult,
): DecisionLogRecord {
  return {
    timestamp: new Date().toISOString(),
    cycle: context.cycle,
    location: snapshot.location,
    gold: snapshot.gold,
    totalLevel: snapshot.totalLevel,
    combatLevel: snapshot.combatLevel,
    tokens: snapshot.tokens,
    currentAction: snapshot.currentAction,
    inventory: snapshot.inventory,
    acceptedQuests: snapshot.acceptedQuests,
    pendingQuests: snapshot.pendingQuests,
    combatPhase: snapshot.combatPhase,
    flags: snapshot.flags,
    discoveredUnregisteredRoutes: snapshot.discovered?.unregisteredRoutes,
    allowedActions: allowed,
    chosenAction,
    executeOutcome: result.outcome,
    backoffMs: result.backoffMs,
    gatherRotationIndex: context.gatherRotationIndex,
    lastAction: context.lastAction,
    playbook: snapshot.extensions?.earlySystemsPlaybook ?? null,
  };
}

export async function logDecision(
  snapshot: GameSnapshot,
  context: AutopilotContext,
  allowed: AutopilotAction[],
  chosenAction: AutopilotAction,
  result: ActionResult,
): Promise<void> {
  const record = buildDecisionRecord(snapshot, context, allowed, chosenAction, result);
  await appendJsonl('decisions.jsonl', record);
}
