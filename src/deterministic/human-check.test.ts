import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emojiForPromptName, parseEmojiPromptTarget } from './human-check.js';

describe('parseEmojiPromptTarget', () => {
  it('parses Press the X emoji gather prompt', () => {
    assert.equal(
      parseEmojiPromptTarget('Please Press the sun emoji to continue'),
      'sun',
    );
  });

  it('returns undefined for Quick check matching-emoji copy', () => {
    const body = `Quick check
Thanks for playing. Choose the matching emoji below so we know you're here.`;
    assert.equal(parseEmojiPromptTarget(body), undefined);
  });
});

describe('emojiForPromptName', () => {
  it('maps known emoji names', () => {
    assert.equal(emojiForPromptName('sun'), '☀️');
    assert.equal(emojiForPromptName('star emoji'), '⭐');
    assert.equal(emojiForPromptName('unknown'), undefined);
  });
});
