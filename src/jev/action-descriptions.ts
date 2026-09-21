import type { AutopilotAction } from '../types.js';

/** Human-readable criteria for HttpJev choice questions. */
export const ACTION_DESCRIPTIONS: Record<AutopilotAction, string> = {
  continue_current:
    'Keep the current gather, craft, hunt, or battle running; do not interrupt',
  gather_oak: 'Start or continue woodcutting Oak Logs for quest mats and XP',
  gather_yew: 'Start woodcutting Yew Logs for higher-level woodcutting XP',
  mine_coal: 'Start mining Coal Ore for smithing mats and combat stats',
  fish_cod: 'Start fishing Cod for food and fishing XP (needs bait)',
  buy_bait: 'Buy Cheap Bait at merchants to enable fishing (costs gold)',
  hunt_battle: 'Run combat hunt → stop → battle for kill quests and combat XP',
  quest_talk_accept: 'Talk to NPC and accept a pending nearby quest',
  quest_turnin: 'Turn in an accepted quest that is complete',
  craft_if_ready: 'Smelt or craft when materials are available and skill Start is ready',
  sell_junk: 'Sell vendor trash items to free inventory and gain gold',
  idle: 'Wait and backoff when no productive action is clear',
};

export function actionCriteria(
  allowed: AutopilotAction[],
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const action of allowed) {
    criteria[action] = ACTION_DESCRIPTIONS[action];
  }
  return criteria;
}
