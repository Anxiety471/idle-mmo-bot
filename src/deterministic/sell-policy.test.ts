import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideSale,
  parseDetailQuantity,
  parseDetailType,
  parseSellPolicy,
  parseTileQuantity,
  parseTooltipName,
} from './sell-policy.js';

const policy = parseSellPolicy({});

describe('sell policy (round 7: sell useless inventory)', () => {
  it('never sells protected items whatever the quantity', () => {
    for (const name of ['Cooked Cod', 'Raw Cod', 'Cod', 'Cheap Bait', 'Coal Ore', 'Blue Scroll', 'Yew Log']) {
      assert.equal(decideSale({ name, qty: 99999, type: 'Crafting' }, policy).sell, 0, name);
    }
  });

  it('sells crafting loot above the per-item keep (150)', () => {
    assert.deepEqual(decideSale({ name: 'Goblin Totem', qty: 790, type: 'Crafting' }, policy).sell, 640);
    assert.equal(decideSale({ name: 'Goblin Pouch', qty: 282, type: 'Crafting' }, policy).sell, 132);
    assert.equal(decideSale({ name: 'Goblin Crown', qty: 30, type: 'Crafting' }, policy).sell, 0);
  });

  it('never sells non-crafting types or unknown types', () => {
    assert.equal(decideSale({ name: 'Iron Sword', qty: 500, type: 'Weapon' }, policy).sell, 0);
    assert.equal(decideSale({ name: 'Mystery', qty: 500, type: 'Collectable' }, policy).sell, 0);
    assert.equal(decideSale({ name: 'Goblin Totem', qty: 790 }, policy).sell, 0);
  });

  it('protects pet / gear names even if typed Crafting', () => {
    assert.equal(decideSale({ name: 'Pet Egg Shard', qty: 900, type: 'Crafting' }, policy).sell, 0);
  });

  it('keeps a whole stack a quest names', () => {
    const d = decideSale({ name: 'Goblin Pouch', qty: 282, type: 'Crafting' }, policy, ['Goblin Pouch Collector']);
    assert.equal(d.sell, 0);
    assert.equal(d.reason, 'quest');
  });

  it('Oak Log is protected by default (round 8)', () => {
    assert.equal(decideSale({ name: 'Oak Log', qty: 231 }, policy).sell, 0);
    assert.equal(decideSale({ name: 'Oak Log', qty: 2900, type: 'Log' }, policy).sell, 0);
    assert.equal(decideSale({ name: 'Oak Log', qty: 2900, type: 'Crafting' }, policy).reason, 'keep-list');
  });

  it('SELL_OAK_SURPLUS=true re-enables Oak surplus: only above 500, down to 200', () => {
    const p = parseSellPolicy({ SELL_OAK_SURPLUS: 'true' });
    assert.equal(decideSale({ name: 'Oak Log', qty: 231 }, p).sell, 0);
    assert.equal(decideSale({ name: 'Oak Log', qty: 2900 }, p).sell, 2700);
  });

  it('only Crafting-type drops are sold (resources/materials/logs kept)', () => {
    assert.equal(decideSale({ name: 'Iron Ore', qty: 5000, type: 'Resource' }, policy).sell, 0);
    assert.equal(decideSale({ name: 'Thing', qty: 5000, type: 'Material' }, policy).sell, 0);
    assert.equal(decideSale({ name: 'Birch Log', qty: 5000, type: 'Log' }, policy).sell, 0);
  });

  it('env keep-list and per-item keeps are configurable', () => {
    const p = parseSellPolicy({ SELL_KEEP_ITEMS: 'Goblin Totem', SELL_KEEP_QTY: 'Goblin Pouch:250', SELL_LOOT_KEEP: '50' });
    assert.equal(decideSale({ name: 'Goblin Totem', qty: 790, type: 'Crafting' }, p).sell, 0);
    assert.equal(decideSale({ name: 'Goblin Pouch', qty: 282, type: 'Crafting' }, p).sell, 32);
    assert.equal(decideSale({ name: 'Ducks Mouth', qty: 150, type: 'Crafting' }, p).sell, 100);
  });

  it('parses live inventory UI strings', () => {
    assert.equal(parseTileQuantity('790 1'), 790);
    assert.equal(parseTileQuantity('1.5K'), 1500);
    assert.equal(parseTileQuantity('17.19K'), 17190);
    assert.equal(parseTooltipName('Goblin Totem Level 1'), 'Goblin Totem');
    const detail =
      'Goblin Totem A primitive idol, carved with grotesque goblin faces, emanating a strange aura. Quantity 790 Type Crafting';
    assert.equal(parseDetailType(detail), 'Crafting');
    assert.equal(parseDetailQuantity('Blue Scroll This item is a collectible. Quantity 1,519'), 1519);
  });
});
