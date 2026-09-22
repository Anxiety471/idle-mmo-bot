import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ManagePetsOptions } from './pets.js';

/** Mirrors managePets allowEquip default (true unless explicitly false). */
function resolveAllowEquip(options: ManagePetsOptions = {}): boolean {
  return options.allowEquip !== false;
}

describe('managePets options', () => {
  it('allowEquip defaults to true', () => {
    assert.equal(resolveAllowEquip(), true);
    assert.equal(resolveAllowEquip({}), true);
    assert.equal(resolveAllowEquip({ allowEquip: true }), true);
  });

  it('allowEquip false skips equip (busy maintenance)', () => {
    assert.equal(resolveAllowEquip({ allowEquip: false }), false);
  });
});
