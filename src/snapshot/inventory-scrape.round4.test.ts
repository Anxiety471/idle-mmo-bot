import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trackedInventoryKeysMissing } from './inventory-scrape.js';

describe('trackedInventoryKeysMissing', () => {
  it('does not treat bare Cod as a tracked missing key', () => {
    const counts = {
      'Cooked Cod': 10,
      'Raw Cod': 5,
      'Coal Ore': 1,
      'Cheap Bait': 2,
    };
    const missing = trackedInventoryKeysMissing(counts);
    assert.ok(!missing.includes('Cod'));
    assert.deepEqual(missing, []);
  });
});
