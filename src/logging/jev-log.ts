import type { Answer } from '../jev/typesafe-client.js';
import { appendJsonl } from './jsonl-writer.js';
import { getLogContext } from './log-context.js';

export type JevMethodName =
  | 'chooseNextAction'
  | 'shouldInterruptGather'
  | 'decideHuntStop'
  | 'chooseStance'
  | 'chooseMaxEnemies'
  | 'shouldFlee'
  | 'pickQuestPriority';

export interface JevLogRecord {
  timestamp: string;
  method: JevMethodName;
  provider: 'HttpJev' | 'ProgressiveStubJev';
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Primary answer for the question key (choice/noul/score + confidence/probabilities). */
  answer?: Answer;
  /** All answers returned by System One when applicable. */
  answers?: Record<string, Answer>;
  result: unknown;
  fallback: boolean;
  error?: string;
  cycle?: number;
}

export async function logJevCall(record: Omit<JevLogRecord, 'timestamp' | 'cycle'>): Promise<void> {
  const entry: JevLogRecord = {
    timestamp: new Date().toISOString(),
    cycle: getLogContext().cycle,
    ...record,
  };
  await appendJsonl('jev.jsonl', entry);
}
