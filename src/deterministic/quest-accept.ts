import type { SnapshotQuest } from '../types.js';

export const HEARTH_QUEST = 'Wood for the Hearth';
export const GOBLIN_QUEST = 'Goblin Menace';

/** Default accept dialogue for Wood for the Hearth (farm-hearth / live-tested). */
export const HEARTH_ACCEPT_DIALOGUE = "Right. I'll fetch the logs.";

/** Quest titles in descending autopilot value when progress is met. */
const PENDING_QUEST_VALUE_ORDER = [
  HEARTH_QUEST,
  GOBLIN_QUEST,
  "A Duck's Whisper",
  "A Rabbit's Fortune",
  'A Rabbits Fortune',
] as const;

/** Parse "150 / 150" or "Oak Log 150 / 150" into numeric progress. */
export function parseQuestProgressFraction(
  progress?: string,
): { current: number; total: number } | null {
  if (!progress) return null;
  const match = progress.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  const current = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return { current, total };
}

/** True when quest progress text shows quota met (e.g. 150/150). */
export function isQuestProgressMet(progress?: string): boolean {
  const parsed = parseQuestProgressFraction(progress);
  if (!parsed) return false;
  return parsed.current >= parsed.total;
}

function questValueRank(title: string): number {
  const index = PENDING_QUEST_VALUE_ORDER.findIndex((known) => title.includes(known));
  return index === -1 ? PENDING_QUEST_VALUE_ORDER.length : index;
}

function comparePendingQuests(a: SnapshotQuest, b: SnapshotQuest): number {
  const aMet = isQuestProgressMet(a.progress);
  const bMet = isQuestProgressMet(b.progress);
  if (aMet !== bMet) return aMet ? -1 : 1;

  const valueDiff = questValueRank(a.title) - questValueRank(b.title);
  if (valueDiff !== 0) return valueDiff;

  return a.title.localeCompare(b.title);
}

/** Pick the best pending quest card to open for Talk/Accept. */
export function rankPendingQuestForAccept(quests: SnapshotQuest[]): SnapshotQuest | undefined {
  if (quests.length === 0) return undefined;
  return [...quests].sort(comparePendingQuests)[0];
}

/** Pending quest with progress quota met — safe to interrupt gather for accept/turn-in. */
export function hasEasyCompletePendingQuest(quests: SnapshotQuest[]): boolean {
  return quests.some((q) => isQuestProgressMet(q.progress));
}

/** Known accept dialogue for a quest title, when available. */
export function getQuestDialogueLine(title: string): string | undefined {
  if (title.includes(HEARTH_QUEST)) return HEARTH_ACCEPT_DIALOGUE;
  return undefined;
}
