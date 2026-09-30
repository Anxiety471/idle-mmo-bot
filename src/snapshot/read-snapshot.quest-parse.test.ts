import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeQuestTitleKey } from './read-snapshot.js';

describe('normalizeQuestTitleKey', () => {
  it('normalizes apostrophe and case variants', () => {
    assert.equal(
      normalizeQuestTitleKey("A Duck's Whisper"),
      normalizeQuestTitleKey('A Ducks Whisper'),
    );
    assert.equal(
      normalizeQuestTitleKey('A Rabbits Fortune'),
      normalizeQuestTitleKey("A Rabbit's Fortune"),
    );
  });
});
