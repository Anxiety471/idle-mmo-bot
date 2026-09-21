import type { JevConfig } from './jev-config.js';

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export class TypeSafeClient {
  constructor(private readonly config: JevConfig) {}

  async systemOne(
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<SystemOneResponse> {
    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        state,
        questions,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as
      | SystemOneResponse
      | { error?: { message?: string }; message?: string };

    if (!response.ok) {
      const message =
        (body as { error?: { message?: string } }).error?.message ??
        (body as { message?: string }).message ??
        `HTTP ${response.status}`;
      throw new Error(`TypeSafe API error: ${message}`);
    }

    if (!body || typeof body !== 'object' || !('answers' in body)) {
      throw new Error('TypeSafe API returned an invalid response');
    }

    return body as SystemOneResponse;
  }
}
