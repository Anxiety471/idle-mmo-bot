import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildInventoryMap,
  decodeIdleMmoMetaSlug,
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

  it('parses compound badge text like 6.1K 1 (qty + quality pip)', () => {
    assert.equal(parseQuantityString('6.1K 1'), 6100);
    assert.equal(parseQuantityString('495'), 495);
    assert.equal(parseQuantityString('2.9K'), 2900);
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

  it('decodes IdleMMO meta-base64 CDN skins (coal.png → Coal Ore)', () => {
    const coalSrc =
      'https://cdn.idle-mmo.com/cdn-cgi/image/width=150,height=150,format=auto/uploaded/skins/8tpdC3JzngzulwN5Sd5L6l711jyGO6-metaY29hbC5wbmc=-.png';
    assert.equal(decodeIdleMmoMetaSlug(coalSrc), 'coal');
    assert.equal(itemNameFromImageSrc(coalSrc), 'Coal Ore');

    const oakSrc =
      'https://cdn.idle-mmo.com/cdn-cgi/image/width=150/uploaded/skins/xWOBaimvLZD0AnHX2ErXz5UzcOI3Q2-metab2FrLnBuZw==-.png';
    assert.equal(decodeIdleMmoMetaSlug(oakSrc), 'oak');
    assert.equal(itemNameFromImageSrc(oakSrc), 'Oak Log');

    const cookedSrc =
      'https://cdn.idle-mmo.com/uploaded/skins/abc-metaY29va2VkIGNvZC5wbmc=-.png';
    assert.equal(decodeIdleMmoMetaSlug(cookedSrc), 'cooked cod');
    assert.equal(itemNameFromImageSrc(cookedSrc), 'Cooked Cod');
  });

  it('decodes Cheap Bait meta small 3.png and cod.png → Raw Cod (live Melriel skins)', () => {
    // Live IdleBocchi inventory: Cheap Bait uses small 3.png, not bait.png.
    const baitSrc =
      'https://cdn.idle-mmo.com/cdn-cgi/image/width=150,height=150,format=auto/uploaded/skins/3SIaLLz6ogS0VLjBjFrFumeePMSZ7r-metac21hbGwgMy5wbmc=-.png';
    assert.equal(decodeIdleMmoMetaSlug(baitSrc), 'small 3');
    assert.equal(itemNameFromImageSrc(baitSrc), 'Cheap Bait');
    assert.equal(parseQuantityString('8 1'), 8);

    const rawCodSrc =
      'https://cdn.idle-mmo.com/cdn-cgi/image/width=150,height=150,format=auto/uploaded/skins/SwtHyQb12EbLINXI8f1NM7iDDCrwTI-metaY29kLnBuZw==-.png';
    assert.equal(decodeIdleMmoMetaSlug(rawCodSrc), 'cod');
    assert.equal(itemNameFromImageSrc(rawCodSrc), 'Raw Cod');
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
  it('returns an empty map for null scrape results', () => {
    assert.deepEqual(sanitizeInventoryCounts(null), {});
    assert.deepEqual(sanitizeInventoryCounts(undefined), {});
  });

  it('drops Code of Conduct chrome keys but keeps large Cod / Raw Cod stacks', () => {
    const counts = sanitizeInventoryCounts({
      Cod: 500,
      'Raw Cod': 495,
      'Code of Conduct': 1,
      'Oak Log': 10,
    });
    assert.equal(counts['Oak Log'], 10);
    assert.equal(counts.Cod, 500);
    assert.equal(counts['Raw Cod'], 495);
    assert.equal(counts['Code of Conduct'], undefined);
  });

  it('keeps realistic Cod stacks', () => {
    const counts = sanitizeInventoryCounts({ Cod: 15 });
    assert.equal(counts.Cod, 15);
  });
});

describe('buildInventoryMap', () => {
  it('returns an empty map when text and DOM inventory are null', () => {
    assert.deepEqual(buildInventoryMap(null, null), {});
  });

  it('merges text and DOM counts for common early-game items', () => {
    const text = 'Inventory\nSort by';
    const dom = {
      'Oak Log': 25,
      'Coal Ore': 30,
      'Cheap Bait': 20,
      'Raw Cod': 12,
      'Cooked Cod': 5,
    };
    const inventory = buildInventoryMap(text, dom);
    assert.deepEqual(inventory, dom);
  });
});

describe('detectHasBait', () => {
  it('treats null inventory as empty', () => {
    assert.equal(detectHasBait(null, null), false);
  });

  it('detects bait from inventory map or visible text', () => {
    assert.equal(detectHasBait({ 'Cheap Bait': 3 }, ''), true);
    assert.equal(detectHasBait({}, 'You have Cheap Bait'), true);
    assert.equal(detectHasBait({}, 'inventory is empty'), false);
  });
});
