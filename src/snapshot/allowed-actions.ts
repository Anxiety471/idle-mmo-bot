import type { AppConfig } from '../config.js';
import type { AutopilotAction, GameSnapshot } from '../types.js';

const GATHER_ACTIONS: AutopilotAction[] = [
  'gather_oak',
  'gather_yew',
  'mine_coal',
  'fish_cod',
];

const KILL_QUEST_PATTERN = /goblin|duck|rabbit|menace|fortune|whisper/i;

function hasKillQuest(snapshot: GameSnapshot): boolean {
  const quests = [...snapshot.acceptedQuests, ...snapshot.pendingQuests];
  return quests.some((q) => KILL_QUEST_PATTERN.test(q.title) && !q.canTurnIn);
}

function hasTurnInReady(snapshot: GameSnapshot): boolean {
  return snapshot.acceptedQuests.some((q) => q.canTurnIn);
}

function hasCraftMaterials(snapshot: GameSnapshot): boolean {
  return (snapshot.inventory['Coal Ore'] ?? 0) >= 1;
}

function hasJunkToSell(snapshot: GameSnapshot, junkItems: string[]): boolean {
  return junkItems.some((item) => (snapshot.inventory[item] ?? 0) > 0);
}

function inventoryPressure(snapshot: GameSnapshot): boolean {
  const totalItems = Object.values(snapshot.inventory).reduce((sum, n) => sum + n, 0);
  return totalItems >= 40 || (snapshot.gold ?? 999) < 50;
}

/** Derive allowed supervisor actions from snapshot + config. */
export function deriveAllowedActions(
  snapshot: GameSnapshot,
  config: AppConfig,
  junkItems: string[],
): AutopilotAction[] {
  const allowed = new Set<AutopilotAction>(['idle']);

  if (!snapshot.flags.sessionValid) {
    return ['idle'];
  }

  if (snapshot.currentAction?.busy || snapshot.flags.inBattle || snapshot.combatPhase !== 'none') {
    allowed.add('continue_current');
  }

  if (hasTurnInReady(snapshot)) {
    allowed.add('quest_turnin');
  }

  if (snapshot.pendingQuests.length > 0) {
    allowed.add('quest_talk_accept');
  }

  if (!snapshot.flags.gatherBusy && !snapshot.flags.inBattle) {
    for (const action of GATHER_ACTIONS) {
      if (action === 'fish_cod' && !snapshot.flags.hasBait) continue;
      allowed.add(action);
    }
  }

  if (!snapshot.flags.hasBait && (snapshot.gold ?? 0) >= 2 && (config.buyBait || hasKillQuest(snapshot))) {
    allowed.add('buy_bait');
  }

  if (hasKillQuest(snapshot) || (snapshot.combatLevel ?? 1) < Math.max(5, (snapshot.totalLevel ?? 10) * 0.2)) {
    allowed.add('hunt_battle');
  }

  if (hasCraftMaterials(snapshot)) {
    allowed.add('craft_if_ready');
  }

  if (hasJunkToSell(snapshot, junkItems) || inventoryPressure(snapshot)) {
    allowed.add('sell_junk');
  }

  return [...allowed];
}

export function parseJunkSellItems(): string[] {
  const raw = process.env.JUNK_SELL_ITEMS?.trim();
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ['Burnt Cod', 'Burnt Fish', 'Burnt Salmon'];
}
