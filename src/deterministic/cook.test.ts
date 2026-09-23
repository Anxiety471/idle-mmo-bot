import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cookInterruptDecision } from './cook.js';

describe('cookInterruptDecision', () => {
  it('starts cooking when nothing else is running', () => {
    assert.equal(cookInterruptDecision('Cooking\nCooked Cod\nStart', false), 'proceed');
  });

  it('leaves an in-progress cook alone', () => {
    const text = 'CURRENT ACTION\nCooking\nCooked Cod\n8s';
    assert.equal(cookInterruptDecision(text, true), 'already_busy');
  });

  it('interrupts a hunt when the caller is cooking before battle', () => {
    const text = 'CURRENT ACTION\nHunting\nTotal Enemies Found\n12';
    assert.equal(cookInterruptDecision(text, true), 'proceed');
    assert.equal(cookInterruptDecision(text, false), 'already_busy');
  });
});
