import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldReuseInventoryDomCache } from './inventory-scrape.js';

describe('shouldReuseInventoryDomCache', () => {
  it('reuses cache within refresh interval and max age', () => {
    const cache = { at: 1_000 };
    assert.equal(
      shouldReuseInventoryDomCache(2, cache, 2_000, { refreshEvery: 4, maxAgeMs: 10_000 }),
      true,
    );
  });

  it('refreshes on cycle multiples and when cache is stale', () => {
    const cache = { at: 1_000 };
    assert.equal(
      shouldReuseInventoryDomCache(4, cache, 2_000, { refreshEvery: 4, maxAgeMs: 10_000 }),
      false,
    );
    assert.equal(
      shouldReuseInventoryDomCache(2, cache, 20_000, { refreshEvery: 4, maxAgeMs: 5_000 }),
      false,
    );
    assert.equal(shouldReuseInventoryDomCache(2, null, 2_000), false);
  });
});
