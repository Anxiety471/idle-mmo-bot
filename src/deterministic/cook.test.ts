import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cookBatchQuantity,
  cookInterruptDecision,
  isActiveCookedCodAction,
  matchesCookedCodRecipeName,
} from './cook.js';

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

describe('cookBatchQuantity', () => {
  it('caps the cook queue at the default batch and at what the panel allows', () => {
    assert.equal(cookBatchQuantity('Cooked Cod\nStart'), 8);
    assert.equal(cookBatchQuantity('You can perform this action 3 times'), 3);
    assert.equal(cookBatchQuantity('You can perform this action 40 times'), 8);
    assert.equal(cookBatchQuantity('You can perform this action 0 times'), 1);
  });
});

describe('matchesCookedCodRecipeName', () => {
  it('matches the Cooked Cod card prefix and ignores other controls', () => {
    assert.equal(
      matchesCookedCodRecipeName('Cooked Cod Lv. 1 2 EXP 8 s 1 x Cod 1 x Coal Ore'),
      true,
    );
    assert.equal(matchesCookedCodRecipeName('  cooked cod'), true);
    assert.equal(matchesCookedCodRecipeName('Cooked Salmon Lv. 1'), false);
    assert.equal(matchesCookedCodRecipeName('Select Cooked Cod'), false);
    assert.equal(matchesCookedCodRecipeName('Cooked Codfish special'), false);
  });
});

describe('isActiveCookedCodAction', () => {
  it('accepts a live Cooked Cod cook in CURRENT ACTION', () => {
    assert.equal(isActiveCookedCodAction('CURRENT ACTION\nCooking\nCooked Cod\n8s'), true);
    assert.equal(
      isActiveCookedCodAction('CURRENT ACTION\nCooked Cod\n+4\nNext item in 0:06'),
      true,
    );
  });

  it('rejects idle pages, other recipes, and a Start click that never took', () => {
    assert.equal(isActiveCookedCodAction('Cooking\nCooked Cod\nStart'), false);
    assert.equal(
      isActiveCookedCodAction('CURRENT ACTION\nCooking\nCooked Salmon\nNext item in 0:08'),
      false,
    );
    assert.equal(
      isActiveCookedCodAction('CURRENT ACTION\nHunting\nTotal Enemies Found\n12'),
      false,
    );
    assert.equal(
      isActiveCookedCodAction('CURRENT ACTION\nIdle\nCooked Cod Lv. 1 2 EXP 8 s'),
      false,
    );
  });

  it('does not treat a later recipe card as the active cook', () => {
    const salmonThenList = `CURRENT ACTION
Cooking
Cooked Salmon
Next item in 0:08
YOUR PROGRESS
Cooked Cod Lv. 1 2 EXP 8 s`;
    assert.equal(isActiveCookedCodAction(salmonThenList), false);
  });

  it('does not treat a hunt counter plus a recipe mention as cooking', () => {
    const hunt = `CURRENT ACTION
Hunting
Total Enemies Found
+12
YOUR PROGRESS
Cooked Cod Lv. 1`;
    assert.equal(isActiveCookedCodAction(hunt), false);
  });
});
