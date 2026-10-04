import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { InventoryStepResult } from '../types.js';
import type { EarlyStageId } from '../autopilot/early-systems-playbook.js';
import { sellItemToVendor } from './vendor-sell.js';

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
  if ((inventory['Coal Ore'] ?? 0) > limits.surplusCoal) return true;
  if ((inventory['Oak Log'] ?? 0) > limits.surplusOak) return true;
  return false;
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
  maxStacks?: number;
}

/** One planned vendor sale. */
export interface VendorSellPlanEntry {
  item: string;
  qty: number;
}

/**
 * Plan vendor sales: when gold is at/above the threshold only large-surplus mats are
 * sold, down to the surplus keep floors (500 Coal / 200 Oak by default). Below the
 * threshold the small legacy floors apply. Cod, Cooked Cod and protected bait never sell.
 */
export function planVendorSales(
  ctx: SellJunkForGoldContext,
  threshold: number,
  limits: SurplusSellLimits = parseSurplusSellLimits(),
  options: SellJunkProtectionOptions = {},
): VendorSellPlanEntry[] {
  const lowGold = ctx.gold < threshold || ctx.playbookStage === 'sell_half' || ctx.playbookStage === 'sell_extras';
  const keepCoal = lowGold ? options.keepCoal ?? DEFAULT_KEEP_COAL : limits.keepCoal;
  const keepOak = lowGold ? options.keepOak ?? DEFAULT_KEEP_OAK : limits.keepOak;
  const plan: VendorSellPlanEntry[] = [];
  for (const junk of ctx.junkItems ?? DEFAULT_JUNK) {
    const qty = ctx.inventory[junk] ?? 0;
    if (qty > 0) plan.push({ item: junk, qty });
  }
  const coal = ctx.inventory['Coal Ore'] ?? 0;
  if (lowGold ? coal > keepCoal : coal > limits.surplusCoal) {
    plan.push({ item: 'Coal Ore', qty: coal - keepCoal });
  }
  const oak = ctx.inventory['Oak Log'] ?? 0;
  if (lowGold ? oak > keepOak : oak > limits.surplusOak) {
    plan.push({ item: 'Oak Log', qty: oak - keepOak });
  }
  return plan.filter((entry) => entry.qty > 0);
}

export interface SellJunkForGoldOptions extends SellJunkProtectionOptions {
  context: SellJunkForGoldContext;
  threshold?: number;
  maxStacks?: number;
}

/** Vendor-sell surplus gather junk for gold; keeps cook fuel and battle food floors. */
export async function sellJunkForGold(
  page: Page,
  config: AppConfig,
  options: SellJunkForGoldOptions,
): Promise<InventoryStepResult | 'sold_partial'> {
  const threshold = options.threshold ?? config.sellGoldThreshold ?? DEFAULT_SELL_GOLD_THRESHOLD;
  const plan = planVendorSales(options.context, threshold, parseSurplusSellLimits(), options).slice(
    0,
    options.maxStacks ?? 2,
  );
  if (plan.length === 0) return 'no_action';
  console.log(
    `[sell] plan gold=${options.context.gold} threshold=${threshold}: ${plan.map((p) => `${p.item} x${p.qty}`).join(', ')}`,
  );
  let sold = 0;
  for (const entry of plan) {
    const result = await sellItemToVendor(page, config, entry.item, entry.qty);
    if (result === 'sold') sold += 1;
  }
  if (sold === 0) return 'failed';
  return sold < plan.length ? 'sold_partial' : 'sold';
}
