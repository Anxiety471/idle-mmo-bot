/**
 * Round 7 heal reserve: the pre-battle Heal used to click "Max Health", which ate up to
 * 68 of 75 Cooked Cod on HitoriIdle in one go. Heal only to a safe HP threshold and
 * never dip into the reserve kept for packed battle food (~25) plus a margin.
 */

/** Cooked Cod always kept back from heals (25 packed per battle + 10 margin). */
export const DEFAULT_HEAL_FOOD_RESERVE = 35;
/** First heal attempt targets this HP %; later attempts step up toward 100. */
export const DEFAULT_HEAL_TARGET_PCT = 60;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** HEAL_FOOD_RESERVE env, default 35. */
export function parseHealFoodReserve(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, 'HEAL_FOOD_RESERVE', DEFAULT_HEAL_FOOD_RESERVE, 0, 10_000);
}

/** HEAL_TARGET_PCT env, default 60 (clamped 10..100). */
export function parseHealTargetPct(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, 'HEAL_TARGET_PCT', DEFAULT_HEAL_TARGET_PCT, 10, 100);
}

/** HP target for heal attempt N (1-based): base, base+20, then 100. */
export function healTargetForAttempt(attempt: number, basePct = parseHealTargetPct()): number {
  if (attempt <= 1) return basePct;
  if (attempt === 2) return Math.min(100, basePct + 20);
  return 100;
}

export interface HealPlanInput {
  /** Quantity the game's "Max Health" button selects (food to reach full HP). */
  maxHealthQty: number;
  /** Current HP % when readable. */
  hpPct?: number;
  /** HP % to heal up to. */
  targetPct: number;
  /** Cooked Cod in the bag, when known. */
  bag?: number;
  /** Cooked Cod that must stay in the bag. */
  reserve: number;
}

export interface HealPlan {
  qty: number;
  reason: 'ok' | 'capped_by_reserve' | 'reserve_low';
  want: number;
}

/**
 * Food to feed: enough to reach `targetPct` (pro-rated from the Max Health quantity),
 * capped so `reserve` Cooked Cod stay in the bag. qty 0 + reserve_low = do not feed.
 */
export function planHealQuantity(input: HealPlanInput): HealPlan {
  const full = Math.max(1, Math.floor(input.maxHealthQty || 1));
  const target = Math.min(100, Math.max(1, input.targetPct));
  let want: number;
  const hp = input.hpPct;
  if (hp !== undefined && Number.isFinite(hp) && hp >= 0 && hp < 100) {
    const frac = Math.min(1, Math.max(0, (target - hp) / (100 - hp)));
    want = Math.ceil(full * frac);
  } else {
    want = Math.ceil((full * target) / 100);
  }
  want = Math.min(full, Math.max(1, want));

  if (input.bag === undefined || !Number.isFinite(input.bag)) {
    return { qty: want, reason: 'ok', want };
  }
  const available = Math.floor(input.bag) - Math.max(0, input.reserve);
  if (available <= 0) return { qty: 0, reason: 'reserve_low', want };
  if (available < want) return { qty: available, reason: 'capped_by_reserve', want };
  return { qty: want, reason: 'ok', want };
}
