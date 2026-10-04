import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { InventoryStepResult } from '../types.js';
import type { EarlyStageId } from '../autopilot/early-systems-playbook.js';
import { sellUselessInventory } from './vendor-sell.js';

const DEFAULT_JUNK = ['Burnt Cod', 'Burnt Fish', 'Burnt Salmon'];

export const DEFAULT_KEEP_COAL = 15;
export const DEFAULT_KEEP_OAK = 5;
export const DEFAULT_KEEP_COD = 1;
export const DEFAULT_KEEP_COOKED_COD = 1;
export const DEFAULT_SELL_GOLD_THRESHOLD = 800;

export interface SellJunkProtectionOptions {
  keepCoal?: number;
  keepOak?: number;
  keepCod?: number;
  keepCookedCod?: number;
}

export interface SellJunkForGoldContext {
  inventory: Record<string, number>;
  gold: number;
  playbookStage?: EarlyStageId;
  baitOwned: boolean;
  hasBait: boolean;
  junkItems?: string[];
}

/** Read SELL_GOLD_THRESHOLD env; default 800. */
export function parseSellGoldThreshold(): number {
  const raw = process.env.SELL_GOLD_THRESHOLD?.trim();
  if (!raw) return DEFAULT_SELL_GOLD_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SELL_GOLD_THRESHOLD;
}

/** True when fish_cod/buy_bait stage and bait is not yet trusted. */
export function needsBaitProtection(ctx: SellJunkForGoldContext): boolean {
  if (ctx.playbookStage !== 'fish_cod' && ctx.playbookStage !== 'buy_bait') return false;
  return !ctx.baitOwned && !ctx.hasBait;
}

/** True if configured junk, surplus Oak, or surplus Coal is present. */
export function hasSurplusVendorJunk(
  ctx: SellJunkForGoldContext,
  options: SellJunkProtectionOptions = {},
): boolean {
  const keepOak = options.keepOak ?? DEFAULT_KEEP_OAK;
  const keepCoal = options.keepCoal ?? DEFAULT_KEEP_COAL;
  const junkItems = ctx.junkItems ?? DEFAULT_JUNK;

  if (junkItems.some((item) => (ctx.inventory[item] ?? 0) > 0)) return true;
  if ((ctx.inventory['Oak Log'] ?? 0) > keepOak) return true;
  if ((ctx.inventory['Coal Ore'] ?? 0) > keepCoal) return true;
  return false;
}

/** Surplus floors: above these, gather mats are sold regardless of gold (round 7 gold drain). */
export const DEFAULT_SURPLUS_COAL = 1000;
export const DEFAULT_SURPLUS_OAK = 500;
/** What a surplus sell keeps back (cook fuel / quest mats). */
export const DEFAULT_SURPLUS_KEEP_COAL = 500;
export const DEFAULT_SURPLUS_KEEP_OAK = 200;

function envIntOr(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface SurplusSellLimits {
  surplusCoal: number;
  surplusOak: number;
  keepCoal: number;
  keepOak: number;
}

/** SELL_SURPLUS_COAL / SELL_SURPLUS_OAK / SELL_KEEP_COAL / SELL_KEEP_OAK. */
export function parseSurplusSellLimits(): SurplusSellLimits {
  return {
    surplusCoal: envIntOr('SELL_SURPLUS_COAL', DEFAULT_SURPLUS_COAL),
    surplusOak: envIntOr('SELL_SURPLUS_OAK', DEFAULT_SURPLUS_OAK),
    keepCoal: envIntOr('SELL_KEEP_COAL', DEFAULT_SURPLUS_KEEP_COAL),
    keepOak: envIntOr('SELL_KEEP_OAK', DEFAULT_SURPLUS_KEEP_OAK),
  };
}

/**
 * True when a gather mat is piled far above any use (e.g. 10,500 Coal / 2,900 Oak while
 * gold drains on bait). Sold even when gold is above SELL_GOLD_THRESHOLD.
 */
export function hasLargeSurplus(
  inventory: Record<string, number>,
  limits: SurplusSellLimits = parseSurplusSellLimits(),
): boolean {
  // Coal is never sold (cook/smelt fuel, user keep-list) — only Oak counts here.
  return (inventory['Oak Log'] ?? 0) > limits.surplusOak;
}

/**
 * Allow when gold is below threshold, the playbook is in a sell stage, or a gather
 * mat has a large surplus. Before round 7 only the first two applied, so with gold
 * above 800 nothing was ever sold (sells=0) while bait buys drained gold.
 */
export function shouldAllowSellJunkForGold(
  ctx: SellJunkForGoldContext,
  threshold: number,
  limits: SurplusSellLimits = parseSurplusSellLimits(),
): boolean {
  if (ctx.gold < threshold) return true;
  if (ctx.playbookStage === 'sell_half' || ctx.playbookStage === 'sell_extras') return true;
  return hasLargeSurplus(ctx.inventory, limits);
}

/** Ordered vendor-sell hints excluding protected battle food and bait when needed. */
export function buildSellItemHints(
  ctx: SellJunkForGoldContext,
  options: SellJunkProtectionOptions = {},
): string[] {
  const keepOak = options.keepOak ?? DEFAULT_KEEP_OAK;
  const keepCoal = options.keepCoal ?? DEFAULT_KEEP_COAL;
  const protectBait = needsBaitProtection(ctx);

  const ordered = [...(ctx.junkItems ?? DEFAULT_JUNK), 'Oak Log', 'Coal Ore'];
  const exclude = new Set(['Cod', 'Cooked Cod', 'Raw Cod']);
  if (protectBait) exclude.add('Cheap Bait');

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of ordered) {
    if (exclude.has(item) || seen.has(item)) continue;
    seen.add(item);

    const qty = ctx.inventory[item] ?? 0;
    if (item === 'Oak Log') {
      if (qty > keepOak) result.push(item);
      continue;
    }
    if (item === 'Coal Ore') {
      if (qty > keepCoal) result.push(item);
      continue;
    }
    if (qty > 0) result.push(item);
  }

  return result;
}

export interface SellJunkForGoldOptions extends SellJunkProtectionOptions {
  context: SellJunkForGoldContext;
  threshold?: number;
  maxStacks?: number;
  questTitles?: string[];
}

/**
 * Map the inventory and vendor-sell useless/surplus items (sell-policy.ts keep-list,
 * per-item keeps, Crafting-type drops only, Oak above its surplus). Every sale is logged
 * with item, quantity and gold.
 */
export async function sellJunkForGold(
  page: Page,
  config: AppConfig,
  options: SellJunkForGoldOptions,
): Promise<InventoryStepResult | 'sold_partial'> {
  try {
    const summary = await sellUselessInventory(page, config, {
      questTitles: options.questTitles,
      maxSales: options.maxStacks ?? 6,
    });
    return summary.sold.length > 0 ? 'sold' : 'no_action';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[sell] sellJunkForGold failed: ${message.slice(0, 200)}`);
    return 'failed';
  }
}
