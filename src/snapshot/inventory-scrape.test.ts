import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildInventoryMap,
  detectHasBait,
  extractItemQuantitiesFromText,
  itemNameFromImageSrc,
  matchKnownItem,
  parseInventoryCounts,
  parseQuantityString,
  sanitizeInventoryCounts,
} from './inventory-scrape.js';

describe('parseQuantityString', () => {
  it('parses plain and K-suffixed counts', () => {
    assert.equal(parseQuantityString('25'), 25);
    assert.equal(parseQuantityString('1.2K'), 1200);
    assert.equal(parseQuantityString('1,234'), 1234);
    assert.equal(parseQuantityString(''), 0);
  });
});

describe('matchKnownItem', () => {
  it('matches canonical names and rejects Code of Conduct for Cod', () => {
    assert.equal(matchKnownItem('Oak Log'), 'Oak Log');
    assert.equal(matchKnownItem('cheap bait'), 'Cheap Bait');
    assert.equal(matchKnownItem('Code of Conduct'), undefined);
    assert.equal(matchKnownItem('Raw Cod'), 'Raw Cod');
    assert.equal(matchKnownItem('Cooked Cod'), 'Cooked Cod');
  });
});

describe('itemNameFromImageSrc', () => {
  it('maps CDN image slugs to item names', () => {
    assert.equal(itemNameFromImageSrc('https://cdn.idle-mmo.com/items/oak-log.png'), 'Oak Log');
    assert.equal(itemNameFromImageSrc('/storage/items/cheap-bait.webp'), 'Cheap Bait');
    assert.equal(itemNameFromImageSrc('/icons/cooked_cod.png'), 'Cooked Cod');
  });
});

describe('parseInventoryCounts', () => {
  it('parses x-separated and line-ending quantities', () => {
    const text = `Inventory
Oak Log x 25
Coal Ore 30
Cheap Bait x 20`;
    const counts = parseInventoryCounts(text);
    assert.equal(counts['Oak Log'], 25);
    assert.equal(counts['Coal Ore'], 30);
    assert.equal(counts['Cheap Bait'], 20);
  });

  it('parses reversed quantity-first patterns', () => {
    const counts = parseInventoryCounts('25 x Oak Log\n15 x Coal Ore');
    assert.equal(counts['Oak Log'], 25);
    assert.equal(counts['Coal Ore'], 15);
  });
});

describe('extractItemQuantitiesFromText', () => {
  it('reads icon-only detail panel text', () => {
    const panel = `Oak Log
Quantity: 42
Sell to Vendor`;
    const counts = extractItemQuantitiesFromText(panel);
    assert.equal(counts['Oak Log'], 42);
  });

  it('reads multiline badge + name stacks', () => {
    const panel = `Cheap Bait
20`;
    const counts = extractItemQuantitiesFromText(panel);
    assert.equal(counts['Cheap Bait'], 20);
  });

  it('extracts cooked cod from battle-food style labels', () => {
    const counts = extractItemQuantitiesFromText('Cooked Cod\n12\nx');
    assert.equal(counts['Cooked Cod'], 12);
  });
});

describe('sanitizeInventoryCounts', () => {
  it('drops Code of Conduct false positives and huge Cod stacks', () => {
    const counts = sanitizeInventoryCounts({
      Cod: 500,
      'Code of Conduct': 1,
      'Oak Log': 10,
    });
    assert.equal(counts['Oak Log'], 10);
    assert.equal(counts.Cod, undefined);
    assert.equal(counts['Code of Conduct'], undefined);
  });

  it('keeps realistic Cod stacks', () => {
    const counts = sanitizeInventoryCounts({ Cod: 15 });
    assert.equal(counts.Cod, 15);
  });
});

describe('buildInventoryMap', () => {
  it('merges text and DOM counts for common early-game items', () => {
    const text = 'Inventory\nSort by';
    const dom = {
      'Oak Log': 25,
      'Coal Ore': 30,
      'Cheap Bait': 20,
      Cod: 12,
      'Cooked Cod': 5,
    };
    const inventory = buildInventoryMap(text, dom);
    assert.deepEqual(inventory, dom);
  });
});

describe('detectHasBait', () => {
  it('detects bait from inventory map or visible text', () => {
    assert.equal(detectHasBait({ 'Cheap Bait': 3 }, ''), true);
    assert.equal(detectHasBait({}, 'You have Cheap Bait'), true);
    assert.equal(detectHasBait({}, 'inventory is empty'), false);
  });
});
