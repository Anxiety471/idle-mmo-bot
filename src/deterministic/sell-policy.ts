/**
 * Round 7 sell policy: which inventory items are useless/surplus and may be vendor-sold.
 *
 * Pure decisions (no Playwright) so they are unit-tested. The live flow in
 * vendor-sell.ts maps the inventory grid (tooltip name + tile quantity + detail "Type")
 * and asks this module what to sell.
 */

/** Never sold, whatever the quantity (battle food, fishing bait, cook/smelt fuel, collectibles). */
export const DEFAULT_SELL_KEEP_ITEMS = [
  'Cooked Cod',
  'Raw Cod',
  'Cod',
  'Burnt Cod',
  'Cheap Bait',
  'Bait',
  'Coal Ore',
  'Coal',
  'Yew Log',
  'Blue Scroll',
  'Cooked Salmon',
  'Salmon',
  'Cooked Tuna',
  'Tuna',
];

/** Item detail types that may be sold. Weapons, armour, tools, pets, food, collectibles never are. */
export const SELLABLE_TYPES = ['crafting', 'resource', 'material'];

/** Name patterns that are always protected (pets, eggs, gear, consumables, keys). */
const PROTECTED_NAME =
  /\b(pet|egg|sword|bow|staff|dagger|axe|pickaxe|rod|helmet|helm|chestplate|armou?r|boots|gloves|shield|ring|amulet|necklace|potion|key|token|chest|essence)\b/i;

export const DEFAULT_SELL_LOOT_KEEP = 150;
export const DEFAULT_SELL_KEEP_OAK = 200;
export const DEFAULT_SELL_SURPLUS_OAK = 500;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface SellPolicy {
  /** Lower-cased names never sold. */
  keep: Set<string>;
  /** Units of each crafting drop kept for quests/recipes (sell only the rest). */
  lootKeep: number;
  /** Per-item keep overrides (lower-cased name → units kept). */
  keepQty: Map<string, number>;
  oakKeep: number;
  oakSurplus: number;
}

/**
 * SELL_KEEP_ITEMS="A,B" adds to the protected list; SELL_KEEP_QTY="Goblin Pouch:300,Ducks Mouth:200"
 * overrides per-item keeps; SELL_LOOT_KEEP (150) is the default keep per crafting drop;
 * SELL_KEEP_OAK (200) / SELL_SURPLUS_OAK (500) govern Oak Log.
 */
export function parseSellPolicy(env: NodeJS.ProcessEnv = process.env): SellPolicy {
  const keep = new Set(DEFAULT_SELL_KEEP_ITEMS.map((s) => s.toLowerCase()));
  for (const name of (env.SELL_KEEP_ITEMS ?? '').split(',')) {
    const n = name.trim().toLowerCase();
    if (n) keep.add(n);
  }
  const keepQty = new Map<string, number>();
  for (const pair of (env.SELL_KEEP_QTY ?? '').split(',')) {
    const [name, qty] = pair.split(':');
    const n = name?.trim().toLowerCase();
    const q = Number.parseInt(qty ?? '', 10);
    if (n && Number.isFinite(q) && q >= 0) keepQty.set(n, q);
  }
  return {
    keep,
    keepQty,
    lootKeep: envInt(env, 'SELL_LOOT_KEEP', DEFAULT_SELL_LOOT_KEEP),
    oakKeep: envInt(env, 'SELL_KEEP_OAK', DEFAULT_SELL_KEEP_OAK),
    oakSurplus: envInt(env, 'SELL_SURPLUS_OAK', DEFAULT_SELL_SURPLUS_OAK),
  };
}

export interface InventoryItem {
  name: string;
  qty: number;
  /** Detail panel "Type" (e.g. Crafting) when read. */
  type?: string;
}

export interface SellDecision {
  sell: number;
  reason: string;
}

/** Quantity of `item` to sell (0 = keep) and why. Quest titles protect matching drops fully. */
export function decideSale(
  item: InventoryItem,
  policy: SellPolicy,
  questTitles: string[] = [],
): SellDecision {
  const name = item.name.trim();
  const lower = name.toLowerCase();
  if (!name || !Number.isFinite(item.qty) || item.qty <= 0) return { sell: 0, reason: 'empty' };
  if (policy.keep.has(lower)) return { sell: 0, reason: 'keep-list' };
  if (PROTECTED_NAME.test(name)) return { sell: 0, reason: 'protected-name' };

  if (lower === 'oak log') {
    if (item.qty <= policy.oakSurplus) return { sell: 0, reason: `oak<=${policy.oakSurplus}` };
    return { sell: item.qty - policy.oakKeep, reason: `oak surplus keep ${policy.oakKeep}` };
  }

  const type = (item.type ?? '').trim().toLowerCase();
  if (!type) return { sell: 0, reason: 'type-unknown' };
  if (!SELLABLE_TYPES.includes(type)) return { sell: 0, reason: `type ${item.type}` };

  // A quest naming this item (e.g. "Goblin Pouch" in a title) keeps the whole stack.
  const words = lower.split(/\s+/).filter((w) => w.length > 3);
  const questHit = questTitles.some((title) => {
    const t = title.toLowerCase();
    return t.includes(lower) || (words.length > 0 && words.every((w) => t.includes(w)));
  });
  if (questHit) return { sell: 0, reason: 'quest' };

  const keep = policy.keepQty.get(lower) ?? policy.lootKeep;
  if (item.qty <= keep) return { sell: 0, reason: `keep ${keep}` };
  return { sell: item.qty - keep, reason: `loot surplus keep ${keep}` };
}

/** Parse tile quantity text like "790 1", "1.5K", "17.19K" → first number. */
export function parseTileQuantity(text: string): number {
  const token = text.trim().replace(/,/g, '').match(/(\d+(?:\.\d+)?)([kKmM]?)/);
  if (!token) return 0;
  const n = Number.parseFloat(token[1]);
  const mult = /k/i.test(token[2]) ? 1000 : /m/i.test(token[2]) ? 1_000_000 : 1;
  return Math.round(n * mult);
}

/** Tooltip "Goblin Totem Level 1" → "Goblin Totem". */
export function parseTooltipName(tip: string): string {
  return tip.replace(/\s+/g, ' ').trim().replace(/\s+Level\s+\d+.*$/i, '').trim();
}

/** Detail text "... Quantity 790 Type Crafting" → "Crafting". */
export function parseDetailType(text: string): string | undefined {
  const m = text.replace(/\s+/g, ' ').match(/\bType\s+([A-Za-z]+)/);
  return m?.[1]?.trim();
}

/** Detail text "... Quantity 1,519" → 1519. */
export function parseDetailQuantity(text: string): number | undefined {
  const m = text.replace(/\s+/g, ' ').match(/\bQuantity\s+([\d,]+)/);
  if (!m) return undefined;
  const n = Number.parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
}
