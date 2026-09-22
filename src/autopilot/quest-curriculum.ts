/**
 * Quest curriculum — score visible quests by difficulty vs current ability and
 * expose preferred / deprioritized actions for HttpJev + playbook filters.
 *
 * Example flow: Wood for the Hearth → quest_talk_accept → gather_oak → quest_turnin.
 */

import type { AutopilotAction, GameSnapshot, SkillId, SnapshotQuest } from '../types.js';

export type QuestKind = 'gather' | 'kill' | 'unknown';
export type QuestDifficulty = 'easy' | 'medium' | 'hard';

export interface ScoredQuest {
  title: string;
  tab: SnapshotQuest['tab'];
  progress?: string;
  canTurnIn: boolean;
  kind: QuestKind;
  difficulty: QuestDifficulty;
  /** Higher = more urgent for the supervisor. */
  importance: number;
  progressCurrent?: number;
  progressTarget?: number;
  completable: boolean;
  gatherAction?: AutopilotAction;
  gatherItem?: string;
}

export interface QuestCurriculum {
  scoredQuests: ScoredQuest[];
  topQuest?: ScoredQuest;
  preferredActions: AutopilotAction[];
  deprioritizedActions: AutopilotAction[];
  interruptActions: AutopilotAction[];
  hint: string;
  hasEasyFinishableQuest: boolean;
}

interface QuestDefinition {
  titlePattern: RegExp;
  kind: QuestKind;
  gatherItem?: string;
  gatherAction?: AutopilotAction;
  skillId?: SkillId;
  defaultTarget?: number;
  killPattern?: RegExp;
}

const HEARTH_QUEST = 'Wood for the Hearth';
const GOBLIN_QUEST = 'Goblin Menace';

const QUEST_DEFINITIONS: QuestDefinition[] = [
  {
    titlePattern: /Wood for the Hearth/i,
    kind: 'gather',
    gatherItem: 'Oak Log',
    gatherAction: 'gather_oak',
    skillId: 'woodcutting',
    defaultTarget: 150,
  },
  {
    titlePattern: /Goblin Menace/i,
    kind: 'kill',
    defaultTarget: 30,
    killPattern: /goblin/i,
  },
  {
    titlePattern: /duck|rabbit|menace|fortune|whisper/i,
    kind: 'kill',
    defaultTarget: 10,
  },
];

const QUEST_DEPRIORITIZE_WHEN_EASY: AutopilotAction[] = [
  'fish_cod',
  'hunt_battle',
  'hunt_rabbits',
];

function invCount(snapshot: GameSnapshot, names: string[]): number {
  let max = 0;
  for (const name of names) {
    max = Math.max(max, snapshot.inventory[name] ?? 0);
  }
  for (const [key, qty] of Object.entries(snapshot.inventory)) {
    const keyLower = key.toLowerCase();
    for (const n of names) {
      const nLower = n.toLowerCase();
      if (keyLower === nLower) {
        max = Math.max(max, qty);
        continue;
      }
      const escaped = nLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`);
      if (re.test(keyLower)) max = Math.max(max, qty);
    }
  }
  return max;
}

export function parseQuestProgress(progress?: string): { current: number; target: number } | undefined {
  if (!progress) return undefined;
  const match = progress.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return undefined;
  const current = Number.parseInt(match[1] ?? '', 10);
  const target = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) return undefined;
  return { current, target };
}

function matchQuestDefinition(title: string): QuestDefinition | undefined {
  return QUEST_DEFINITIONS.find((def) => def.titlePattern.test(title));
}

function estimateGatherDifficulty(
  snapshot: GameSnapshot,
  def: QuestDefinition,
): { difficulty: QuestDifficulty; completable: boolean } {
  const skill = def.skillId ? (snapshot.skillLevels[def.skillId] ?? 1) : 1;
  if (skill >= 1) return { difficulty: 'easy', completable: true };
  return { difficulty: 'medium', completable: true };
}

function estimateKillDifficulty(
  snapshot: GameSnapshot,
  progress?: { current: number; target: number },
  defaultTarget = 10,
): { difficulty: QuestDifficulty; completable: boolean } {
  const combat = snapshot.combatLevel ?? 1;
  const target = progress?.target ?? defaultTarget;
  const current = progress?.current ?? 0;
  const remaining = Math.max(0, target - current);
  const ratio = target > 0 ? current / target : 0;

  if (combat <= 3 && (remaining >= 10 || ratio < 0.15)) {
    return { difficulty: 'hard', completable: false };
  }
  if (combat <= 5 && remaining >= 15) {
    return { difficulty: 'medium', completable: combat >= 4 };
  }
  return { difficulty: 'easy', completable: true };
}

function scoreQuest(snapshot: GameSnapshot, quest: SnapshotQuest): ScoredQuest {
  const def = matchQuestDefinition(quest.title);
  const parsed = parseQuestProgress(quest.progress);
  const kind = def?.kind ?? 'unknown';

  let difficulty: QuestDifficulty = 'medium';
  let completable = true;
  let progressCurrent = parsed?.current;
  let progressTarget = parsed?.target ?? def?.defaultTarget;

  if (kind === 'gather' && def?.gatherItem) {
    const inv = invCount(snapshot, [def.gatherItem]);
    if (progressTarget !== undefined && inv > (progressCurrent ?? 0)) {
      progressCurrent = Math.max(progressCurrent ?? 0, inv);
    }
    const gather = estimateGatherDifficulty(snapshot, def);
    difficulty = gather.difficulty;
    completable = gather.completable;
  } else if (kind === 'kill') {
    const kill = estimateKillDifficulty(snapshot, parsed, def?.defaultTarget);
    difficulty = kill.difficulty;
    completable = kill.completable;
  }

  let importance = 30;
  if (quest.canTurnIn) {
    importance = 100;
  } else if (kind === 'gather' && difficulty === 'easy') {
    const ratio =
      progressTarget && progressTarget > 0 && progressCurrent !== undefined
        ? progressCurrent / progressTarget
        : 0;
    if (quest.tab === 'pending') importance = 75;
    else if (ratio >= 0.5) importance = 90;
    else importance = 70;
  } else if (kind === 'kill' && difficulty === 'hard') {
    importance = 15;
  } else if (kind === 'kill') {
    importance = 40;
  }

  return {
    title: quest.title,
    tab: quest.tab,
    progress: quest.progress,
    canTurnIn: quest.canTurnIn,
    kind,
    difficulty,
    importance,
    progressCurrent,
    progressTarget,
    completable,
    gatherAction: def?.gatherAction,
    gatherItem: def?.gatherItem,
  };
}

function buildPreferredActions(top?: ScoredQuest, snapshot?: GameSnapshot): AutopilotAction[] {
  if (!top) return [];

  const preferred: AutopilotAction[] = [];
  if (top.canTurnIn) {
    preferred.push('quest_turnin');
    return preferred;
  }

  if (top.kind === 'gather' && top.difficulty === 'easy') {
    if (top.tab === 'pending') {
      preferred.push('quest_talk_accept');
    } else if (top.tab === 'accepted' && top.gatherAction) {
      preferred.push(top.gatherAction);
    }
  }

  // Turn-in ready on any accepted quest beats gathering.
  if (snapshot?.acceptedQuests.some((q) => q.canTurnIn) && !preferred.includes('quest_turnin')) {
    preferred.unshift('quest_turnin');
  }

  return preferred;
}

function buildHint(top?: ScoredQuest, scored: ScoredQuest[] = []): string {
  if (!top) return '';

  if (top.canTurnIn) {
    return `QUEST CURRICULUM: ${top.title} ready — quest_turnin first.`;
  }

  if (top.title.includes(HEARTH_QUEST)) {
    const prog =
      top.progressCurrent !== undefined && top.progressTarget !== undefined
        ? ` (${top.progressCurrent}/${top.progressTarget} Oak Log)`
        : '';
    if (top.tab === 'pending') {
      return `QUEST CURRICULUM: ${HEARTH_QUEST} pending${prog} — quest_talk_accept, then gather_oak to 150, then quest_turnin. Prefer over fish_cod.`;
    }
    return `QUEST CURRICULUM: ${HEARTH_QUEST} accepted${prog} — gather_oak until Turn In, then quest_turnin. Deprioritize fish_cod / hard hunts.`;
  }

  const hardKill = scored.find((q) => q.kind === 'kill' && q.difficulty === 'hard' && q.tab === 'accepted');
  if (hardKill && top.kind === 'gather') {
    return (
      `QUEST CURRICULUM: finish easy ${top.title} before grinding ${hardKill.title} ` +
      `(combat ${hardKill.progress ?? '0/?'} at low level).`
    );
  }

  return `QUEST CURRICULUM: prioritize ${top.title} (${top.kind}, ${top.difficulty}).`;
}

/** Score all visible quests and derive curriculum hints for Jev + playbook filters. */
export function evaluateQuestCurriculum(snapshot: GameSnapshot): QuestCurriculum {
  const visible = [...snapshot.pendingQuests, ...snapshot.acceptedQuests];
  const scoredQuests = visible.map((q) => scoreQuest(snapshot, q));

  const ranked = [...scoredQuests].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    if (a.canTurnIn !== b.canTurnIn) return a.canTurnIn ? -1 : 1;
    return 0;
  });

  const topQuest = ranked[0];
  const hasEasyFinishableQuest = ranked.some(
    (q) =>
      q.canTurnIn ||
      (q.kind === 'gather' && q.difficulty === 'easy' && (q.tab === 'pending' || q.tab === 'accepted')),
  );

  const preferredActions = buildPreferredActions(topQuest, snapshot);
  const deprioritizedActions: AutopilotAction[] = hasEasyFinishableQuest
    ? [...QUEST_DEPRIORITIZE_WHEN_EASY]
    : [];

  const interruptActions: AutopilotAction[] = [];
  if (hasEasyFinishableQuest && topQuest?.gatherAction) {
    interruptActions.push(topQuest.gatherAction);
  }
  if (hasEasyFinishableQuest && snapshot.acceptedQuests.some((q) => q.canTurnIn)) {
    if (!preferredActions.includes('quest_turnin')) preferredActions.unshift('quest_turnin');
  }

  return {
    scoredQuests,
    topQuest,
    preferredActions,
    deprioritizedActions,
    interruptActions,
    hint: buildHint(topQuest, scoredQuests),
    hasEasyFinishableQuest,
  };
}

export function getQuestCurriculumFromSnapshot(snapshot: GameSnapshot): QuestCurriculum | undefined {
  const raw = snapshot.extensions?.questCurriculum;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as QuestCurriculum;
}

/** HttpJev pickQuestPriority — easy gather quests before hard kill quests. */
export function rankQuestTitlesForPriority(scored: ScoredQuest[]): string[] {
  return [...scored]
    .sort((a, b) => b.importance - a.importance)
    .map((q) => q.title);
}

export { GOBLIN_QUEST, HEARTH_QUEST };
