import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildSellItemHints,
  DEFAULT_KEEP_COAL,
  DEFAULT_KEEP_OAK,
  DEFAULT_SELL_GOLD_THRESHOLD,
  hasSurplusVendorJunk,
  hasLargeSurplus,
  needsBaitProtection,
  parseSellGoldThreshold,
  planVendorSales,
  shouldAllowSellJunkForGold,
  type SellJunkForGoldContext,
} from './sell-junk-for-gold.js';

const ENV_KEYS = ['SELL_GOLD_THRESHOLD'] as const;

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function baseContext(overrides: Partial<SellJunkForGoldContext> = {}): SellJunkForGoldContext {
  return {
    inventory: {},
    gold: 500,
    baitOwned: false,
    hasBait: false,
    junkItems: ['Burnt Cod', 'Burnt Fish', 'Burnt Salmon'],
    ...overrides,
  };
}

describe('parseSellGoldThreshold', () => {
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('defaults to 800 when unset', () => {
    delete process.env.SELL_GOLD_THRESHOLD;
    assert.equal(parseSellGoldThreshold(), DEFAULT_SELL_GOLD_THRESHOLD);
  });

  it('reads SELL_GOLD_THRESHOLD from env', () => {
    process.env.SELL_GOLD_THRESHOLD = '1200';
    assert.equal(parseSellGoldThreshold(), 1200);
  });

  it('falls back to default on invalid value', () => {
    process.env.SELL_GOLD_THRESHOLD = 'not-a-number';
    assert.equal(parseSellGoldThreshold(), DEFAULT_SELL_GOLD_THRESHOLD);
  });
});

describe('hasSurplusVendorJunk', () => {
  it('detects configured junk items', () => {
    const ctx = baseContext({ inventory: { 'Burnt Cod': 2 } });
    assert.equal(hasSurplusVendorJunk(ctx), true);
  });

  it('detects surplus Oak Log above keep floor', () => {
    const ctx = baseContext({ inventory: { 'Oak Log': DEFAULT_KEEP_OAK + 1 } });
    assert.equal(hasSurplusVendorJunk(ctx), true);
  });

  it('detects surplus Coal Ore above keep floor', () => {
    const ctx = baseContext({ inventory: { 'Coal Ore': DEFAULT_KEEP_COAL + 1 } });
    assert.equal(hasSurplusVendorJunk(ctx), true);
  });

  it('returns false when only protected floors remain', () => {
    const ctx = baseContext({
      inventory: {
        'Oak Log': DEFAULT_KEEP_OAK,
        'Coal Ore': DEFAULT_KEEP_COAL,
        'Cod': 1,
        'Cooked Cod': 1,
      },
    });
    assert.equal(hasSurplusVendorJunk(ctx), false);
  });
});

describe('shouldAllowSellJunkForGold', () => {
  it('allows when gold is below threshold', () => {
    const ctx = baseContext({ gold: 799 });
    assert.equal(shouldAllowSellJunkForGold(ctx, 800), true);
  });

  it('blocks when gold is above threshold outside sell stages', () => {
    const ctx = baseContext({ gold: 1200, playbookStage: 'fish_cod' });
    assert.equal(shouldAllowSellJunkForGold(ctx, 800), false);
  });

  it('allows a large Coal/Oak surplus even with high gold (round 7: sells=0 at 10,500 coal)', () => {
    const ctx = baseContext({
      gold: 4492,
      playbookStage: 'fish_cod',
      inventory: { 'Coal Ore': 10500, 'Oak Log': 2900 },
    });
    assert.equal(hasLargeSurplus(ctx.inventory), true);
    assert.equal(shouldAllowSellJunkForGold(ctx, 800), true);
  });

  it('allows during sell_half even with high gold', () => {
    const ctx = baseContext({ gold: 5000, playbookStage: 'sell_half' });
    assert.equal(shouldAllowSellJunkForGold(ctx, 800), true);
  });

  it('allows during sell_extras even with high gold', () => {
    const ctx = baseContext({ gold: 5000, playbookStage: 'sell_extras' });
    assert.equal(shouldAllowSellJunkForGold(ctx, 800), true);
  });
});

describe('needsBaitProtection', () => {
  it('protects bait on fish_cod when bait is not trusted', () => {
    const ctx = baseContext({ playbookStage: 'fish_cod', baitOwned: false, hasBait: false });
    assert.equal(needsBaitProtection(ctx), true);
  });

  it('protects bait on buy_bait when bait is not trusted', () => {
    const ctx = baseContext({ playbookStage: 'buy_bait', baitOwned: false, hasBait: false });
    assert.equal(needsBaitProtection(ctx), true);
  });

  it('does not protect bait once trusted', () => {
    const ctx = baseContext({ playbookStage: 'fish_cod', baitOwned: true, hasBait: false });
    assert.equal(needsBaitProtection(ctx), false);
  });

  it('does not protect bait outside fishing stages', () => {
    const ctx = baseContext({ playbookStage: 'sell_half', baitOwned: false, hasBait: false });
    assert.equal(needsBaitProtection(ctx), false);
  });
});

describe('buildSellItemHints', () => {
  it('excludes Cod and Cooked Cod from hints', () => {
    const ctx = baseContext({
      inventory: {
        Cod: 5,
        'Cooked Cod': 5,
        'Burnt Cod': 2,
      },
    });
    const hints = buildSellItemHints(ctx);
    assert.ok(hints.includes('Burnt Cod'));
    assert.ok(!hints.includes('Cod'));
    assert.ok(!hints.includes('Cooked Cod'));
  });

  it('includes Oak and Coal only when above keep floors', () => {
    const ctx = baseContext({
      inventory: {
        'Oak Log': DEFAULT_KEEP_OAK + 3,
        'Coal Ore': DEFAULT_KEEP_COAL + 2,
      },
    });
    const hints = buildSellItemHints(ctx);
    assert.deepEqual(hints, ['Oak Log', 'Coal Ore']);
  });

  it('excludes Cheap Bait when bait protection is active', () => {
    const ctx = baseContext({
      playbookStage: 'fish_cod',
      inventory: { 'Cheap Bait': 1, 'Burnt Fish': 1 },
    });
    const hints = buildSellItemHints(ctx);
    assert.ok(hints.includes('Burnt Fish'));
    assert.ok(!hints.includes('Cheap Bait'));
  });
});

describe('planVendorSales (round 7)', () => {
  const limits = { surplusCoal: 1000, surplusOak: 500, keepCoal: 500, keepOak: 200 };

  it('high gold: sells surplus down to the surplus keep floors, never cod', () => {
    const ctx = baseContext({
      gold: 4492,
      inventory: { 'Coal Ore': 10500, 'Oak Log': 2900, 'Cooked Cod': 41, 'Raw Cod': 50 },
    });
    assert.deepEqual(planVendorSales(ctx, 800, limits), [
      { item: 'Coal Ore', qty: 10000 },
      { item: 'Oak Log', qty: 2700 },
    ]);
  });

  it('high gold: small piles are kept', () => {
    const ctx = baseContext({ gold: 4492, inventory: { 'Coal Ore': 900, 'Oak Log': 300 } });
    assert.deepEqual(planVendorSales(ctx, 800, limits), []);
  });

  it('low gold: legacy small floors apply', () => {
    const ctx = baseContext({ gold: 100, inventory: { 'Coal Ore': 100, 'Oak Log': 10 } });
    assert.deepEqual(planVendorSales(ctx, 800, limits), [
      { item: 'Coal Ore', qty: 100 - DEFAULT_KEEP_COAL },
      { item: 'Oak Log', qty: 10 - DEFAULT_KEEP_OAK },
    ]);
  });
});
