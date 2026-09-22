import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { InventoryStepResult } from '../types.js';
import type { EarlyStageId } from '../autopilot/early-systems-playbook.js';
import { sellHalfCareful } from './inventory.js';

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

/** Allow when gold is below threshold or playbook is in a sell stage. */
export function shouldAllowSellJunkForGold(
  ctx: SellJunkForGoldContext,
  threshold: number,
): boolean {
  if (ctx.gold < threshold) return true;
  return ctx.playbookStage === 'sell_half' || ctx.playbookStage === 'sell_extras';
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

/** Vendor-sell surplus gather junk for gold; keeps cook fuel and battle food floors. */
export async function sellJunkForGold(
  page: Page,
  config: AppConfig,
  options: SellJunkForGoldOptions,
): Promise<InventoryStepResult | 'sold_partial'> {
  const hints = buildSellItemHints(options.context, options);
  if (hints.length === 0) return 'no_action';

  return sellHalfCareful(page, config, {
    itemHints: hints,
    keepCoal: options.keepCoal ?? DEFAULT_KEEP_COAL,
    keepOak: options.keepOak ?? DEFAULT_KEEP_OAK,
    keepCod: options.keepCod ?? DEFAULT_KEEP_COD,
    keepCookedCod: options.keepCookedCod ?? DEFAULT_KEEP_COOKED_COD,
    maxStacks: options.maxStacks ?? 2,
  });
}
