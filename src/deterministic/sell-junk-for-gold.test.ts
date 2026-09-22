import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildSellItemHints,
  DEFAULT_KEEP_COAL,
  DEFAULT_KEEP_OAK,
  DEFAULT_SELL_GOLD_THRESHOLD,
  hasSurplusVendorJunk,
  needsBaitProtection,
  parseSellGoldThreshold,
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
