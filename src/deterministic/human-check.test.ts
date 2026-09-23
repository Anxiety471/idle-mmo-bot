import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  areEmojiChoicesBlank,
  emojiForPromptName,
  parseEmojiPromptTarget,
} from './human-check.js';
import { verifyBackoffMs } from './poll-interval.js';

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

describe('areEmojiChoicesBlank', () => {
  it('detects blank Quick-check emoji buttons', () => {
    assert.equal(areEmojiChoicesBlank([{ emoji: '' }, { emoji: '' }]), true);
    assert.equal(areEmojiChoicesBlank([{ emoji: '☀️' }, { emoji: '' }]), false);
    assert.equal(areEmojiChoicesBlank([]), false);
  });
});

describe('verifyBackoffMs', () => {
  it('uses long backoff suitable for Cloudflare pressure', () => {
    assert.equal(verifyBackoffMs(5000), 30_000);
    assert.equal(verifyBackoffMs(25_000), 150_000);
  });
});
