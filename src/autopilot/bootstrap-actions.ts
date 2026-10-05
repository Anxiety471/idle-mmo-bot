import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { HuntState } from '../types.js';
import { navigateTo } from '../browser.js';
import { normalizeQuestTitleKey } from '../snapshot/read-snapshot.js';
import { waitForPageReady } from '../browser/page-ready.js';
import { inventoryReadLooksCollapsed } from '../snapshot/snapshot-health.js';
import {
  restartSkillGather,
  readGatherState,
  readSkillState,
  ensureHuntActive,
  isIdleBattleScreen,
  waitForEnemies,
  hasHuntProgress,
  hasPostHuntEnemySelectionReady,
  cookedCodCount,
  inventoryAfterCookedCodSpend,
  needsCookBeforeHunt,
  takeCookedCodSpentOnHeal,
  takePackedBattleFood,
  packedFoodQuantity,
  isHuntActivelyRunning,
  pickBattleEnemy,
  prepareEnemyBattleSelection,
  readHuntState,
  stopHunt,
  configureAndBattle,
  DETERMINISTIC_MAX_ENEMIES,
  deterministicStance,
  monitorInBattle,
  battleMonitorWallClockMs,
  runAway,
  huntMore,
  pickBattleEnemyWithFallback,
  describeEnemyList,
  isFightInProgress,
  openQuest,
  talkQuest,
  turnInQuest,
  isTurnInEnabled,
  switchQuestTab,
  waitForQuestTabsSettled,
  waitForQuestCard,
  waitForQuestDetail,
  navigateToQuestsInterrupting,
  turnInCompletableQuests,
  rankPendingQuestForAccept,
  hasEasyCompletePendingQuest,
  getQuestDialogueLine,
  buyCheapBait,
  baitPurchaseAllowedByGold,
  sellJunkToVendor,
  sellHalfCareful,
  sellJunkForGold,
  hasSurplusVendorJunk,
  shouldAllowSellJunkForGold,
  trySmeltCoal,
} from '../deterministic/index.js';
import type { SellJunkForGoldContext } from '../deterministic/sell-junk-for-gold.js';
import type { SnapshotQuest } from '../types.js';
import type { ActionAllowContext, ActionDefinition, ActionExecuteContext } from './action-types.js';
import { registerAction } from './action-registry.js';
import { tryCookCod } from '../deterministic/cook.js';
import { shouldHardStopHunt } from '../deterministic/hunt-cap.js';
import { equipPet, managePets } from '../deterministic/pets.js';
import {
  formatHuntBattleRoundOutcome,
  getPlaybookFromSnapshot,
  recentBaitPurchase,
  shouldPreferBaitRestock,
  shouldSkipQuestTalkTitle,
} from './early-systems-playbook.js';
import { enemyBacklogTotal, pollUntilHuntStop, shouldSkipHuntMore } from '../jev/hunt-cap.js';
import {
  attemptHumanVerify,
  isHumanCheckPresent,
} from '../deterministic/human-check.js';
import {
  lastBattleConfirmThrottled,
  rateLimitBackoffMs,
  shouldRefreshCookGateAfterFight,
} from '../deterministic/battle-confirm.js';
import { battleGuard } from './battle-guard.js';
import {
  invalidateInventoryDomCache,
  scrapeInventoryFromDom,
} from '../snapshot/inventory-scrape.js';
import {
  createVerifyBudget,
  effectivePollMs,
  verifyBackoffMs,
} from '../deterministic/poll-interval.js';

const KILL_QUEST_PATTERN = /goblin|duck|rabbit|menace|fortune|whisper/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasKillQuest(ctx: ActionAllowContext): boolean {
  const { snapshot } = ctx;
  return [...snapshot.acceptedQuests, ...snapshot.pendingQuests].some(
    (q) => KILL_QUEST_PATTERN.test(q.title) && !q.canTurnIn,
  );
}

function hasTurnInReady(ctx: ActionAllowContext): boolean {
  return ctx.snapshot.acceptedQuests.some((q) => q.canTurnIn);
}

function inventoryPressure(ctx: ActionAllowContext): boolean {
  const total = Object.values(ctx.snapshot.inventory).reduce((s, n) => s + n, 0);
  return total >= 40 || (ctx.snapshot.gold ?? 999) < 50;
}

function hasJunk(ctx: ActionAllowContext): boolean {
  return ctx.junkItems.some((item) => (ctx.snapshot.inventory[item] ?? 0) > 0);
}

function buildSellJunkForGoldContext(ctx: ActionAllowContext): SellJunkForGoldContext {
  const playbook = getPlaybookFromSnapshot(ctx.snapshot);
  return {
    inventory: ctx.snapshot.inventory,
    gold: ctx.snapshot.gold ?? 999,
    playbookStage: playbook?.stage,
    baitOwned: playbook?.baitOwned ?? false,
    hasBait: ctx.snapshot.flags.hasBait,
    junkItems: ctx.junkItems,
  };
}

function gatherIdle(ctx: ActionAllowContext): boolean {
  return !ctx.snapshot.flags.gatherBusy && !ctx.snapshot.flags.inBattle;
}

export interface CombatRoundResult {
  outcome: string;
  backoffMs?: number;
}

function combatRoundOutcome(outcome: string, config: AppConfig): CombatRoundResult {
  if (outcome === 'blocked:verify' || outcome === 'failed:hunt_not_started') {
    return { outcome, backoffMs: verifyBackoffMs(config.pollMs) };
  }
  return { outcome };
}

async function runCombatRound(ctx: ActionExecuteContext): Promise<CombatRoundResult> {
  const { page, config, jev, forceInterrupt } = ctx;
  const pollMs = effectivePollMs(config.pollMs);
  const huntBackoffMs = verifyBackoffMs(config.pollMs);
  const verifyBudget = createVerifyBudget();
  const gatherSnapshot = await readGatherState(page, config);
  const allowInterrupt = forceInterrupt || (await jev.shouldInterruptGather(gatherSnapshot));

  const preVerify = await attemptHumanVerify(page, verifyBudget, pollMs);
  if (preVerify === 'blocked') {
    return combatRoundOutcome('blocked:verify', config);
  }

  const playbook = getPlaybookFromSnapshot(ctx.snapshot);
  const cookTarget = playbook?.targets.cookMin ?? 100;
  const huntCookFloor = playbook?.targets.huntCookFloor ?? 30;
  const huntBatchActive = playbook?.stage === 'hunt_battle_batch' || playbook?.stage === 'hunt_rabbits';
  const cookGateOptions = {
    huntBatchActive,
    huntCookFloor,
  };
  const huntActive = await isHuntActivelyRunning(page);
  const huntPeek = huntActive ? await readHuntState(page) : null;
  const foundNow = huntPeek?.totalEnemiesFound ?? ctx.snapshot.totalEnemiesFound;
  const mustBattle =
    huntActive ||
    shouldHardStopHunt(foundNow, ctx.snapshot.combatLevel, ctx.snapshot.totalLevel) ||
    ctx.snapshot.combatPhase === 'enemy_select';
  if (!mustBattle && needsCookBeforeHunt(ctx.snapshot.inventory, cookTarget, cookGateOptions)) {
    const cooked = ctx.snapshot.inventory['Cooked Cod'] ?? 0;
    console.log(`[combat] Cooked Cod ${cooked}/${cookTarget} — cooking before hunt`);
    if (battleGuard(ctx.snapshot) === 'battle') {
      return combatRoundOutcome('cook_before_hunt:already_busy', config);
    }
    const cookResult = await tryCookCod(page, config, true, {
      cooked,
      target: cookTarget,
      rawAvailable: Math.max(
        ctx.snapshot.inventory['Cod'] ?? 0,
        ctx.snapshot.inventory['Raw Cod'] ?? 0,
      ),
    });
    return combatRoundOutcome(`cook_before_hunt:${cookResult}`, config);
  }
  if (mustBattle && needsCookBeforeHunt(ctx.snapshot.inventory, cookTarget, cookGateOptions)) {
    console.log(
      `[combat] skipping cook-before-hunt — hunt active/over cap (found=${foundNow ?? 'n/a'})`,
    );
  }

  const huntResult = await ensureHuntActive(page, config, allowInterrupt, verifyBudget, {
    currentAction: ctx.snapshot.currentAction,
    combatPhase: ctx.snapshot.combatPhase,
  });

  if (huntResult === 'no_action') {
    await sleep(huntBackoffMs);
    return combatRoundOutcome(`blocked:${huntResult}`, config);
  }
  if (huntResult === 'hunt_active_wait') {
    return combatRoundOutcome('hunt_active:wait', config);
  }
  if (huntResult === 'failed') {
    if (await isHumanCheckPresent(page)) {
      return combatRoundOutcome('blocked:verify', config);
    }
    if (await isIdleBattleScreen(page)) {
      return combatRoundOutcome('failed:hunt_not_started', config);
    }
    return combatRoundOutcome(`failed:${huntResult}`, config);
  }

  let huntState: HuntState;
  if (huntResult === 'enemy_select_ready') {
    huntState = await readHuntState(page);
  } else if (huntResult === 'hunt_started' || huntResult === 'hunt_already_active') {
    if (await isIdleBattleScreen(page)) {
      if (await isHumanCheckPresent(page)) {
        return combatRoundOutcome('blocked:verify', config);
      }
      return combatRoundOutcome('failed:hunt_not_started', config);
    }
    const metricsDeadline = Date.now() + Math.max(pollMs * 30, 60_000);
    let afterWait = await waitForEnemies(page, 60_000, pollMs);
    while (
      !hasHuntProgress(afterWait) &&
      !(await hasPostHuntEnemySelectionReady(page)) &&
      Date.now() < metricsDeadline
    ) {
      await sleep(pollMs);
      afterWait = await waitForEnemies(
        page,
        Math.min(metricsDeadline - Date.now(), 15_000),
        pollMs,
      );
    }
    if (!hasHuntProgress(afterWait) && !(await hasPostHuntEnemySelectionReady(page))) {
      return combatRoundOutcome('hunt_metrics_pending', config);
    }
    huntState = await pollUntilHuntStop(page, config, jev, afterWait, {
      combatLevel: ctx.snapshot.combatLevel,
      totalLevel: ctx.snapshot.totalLevel,
    });
    const stopResult = await stopHunt(page);
    huntState = await prepareEnemyBattleSelection(page, 30_000, pollMs);
    if (huntState.enemies.length === 0) {
      return combatRoundOutcome(`stop:${stopResult}:no_enemies`, config);
    }
  } else {
    return combatRoundOutcome(`failed:unexpected_hunt_state:${huntResult}`, config);
  }

  const picked = pickBattleEnemyWithFallback(huntState.enemies);
  const enemy = picked.enemy;
  if (!enemy) {
    // Nothing fightable: log what was on screen, then go back to hunting instead of
    // returning stop:no_enemies every cycle.
    console.log(
      `[combat] no battle target — enemy list: ${describeEnemyList(huntState.enemies)}; restarting hunt`,
    );
    const again = await huntMore(page, allowInterrupt).catch(() => 'failed' as const);
    return combatRoundOutcome(`stop:no_enemies:huntMore:${again}`, config);
  }
  if (picked.allRestrictive) {
    console.log(
      `[combat] every enemy tile is restrictive (${describeEnemyList(huntState.enemies)}) — opening ${enemy.name} so the heal gate can run`,
    );
  }
  const maxEnemies = DETERMINISTIC_MAX_ENEMIES;
  const stance = deterministicStance(enemy.name);
  console.log(`[combat] deterministic battle config max=full-stack stance=${stance} (no Jev)`);
  console.log(
    `[combat] enemy pick ${enemy.name} qty=${enemy.quantity ?? '?'} idx=${enemy.index} of [` +
      huntState.enemies
        .map((e) => `${e.name}:${e.quantity ?? '?'}${e.restrictive ? '(restrictive)' : ''}`)
        .join(', ') +
      ']',
  );
  // Run Away already on screen before Battle means an older fight is running —
  // it must not be credited again as this round's fight.
  const fightActiveBeforeBattle = await isFightInProgress(page).catch(() => false);
  if (!fightActiveBeforeBattle && battleGuard(ctx.snapshot) === 'battle') {
    // API says a battle is running but this page never rendered it (stale store).
    // A second Battle click is queued without a confirm dialog — do not click.
    console.log('[combat] API current action is BATTLE — not clicking Battle; reloading and waiting');
    await navigateTo(page, config, '/combat/battle').catch(() => undefined);
    return combatRoundOutcome('battle:battle_in_progress:wait', config);
  }
  const battleResult = await configureAndBattle(
    page,
    enemy.index,
    maxEnemies,
    stance,
    allowInterrupt,
    {
      config,
      bagCooked: cookedCodCount(ctx.snapshot.inventory),
    },
  );

  if (battleResult === 'blocked_verify') {
    return combatRoundOutcome('blocked:verify', config);
  }

  if (battleResult === 'battle_in_progress') {
    // Existing/queued fight (Run Away or sidebar "Next enemy in"): no tile walk, no
    // Hunt More, no credit — the next cycle picks up once it ends.
    takePackedBattleFood();
    return combatRoundOutcome('battle:battle_in_progress:wait', config);
  }

  if (battleResult === 'pending_verify' && lastBattleConfirmThrottled()) {
    // Round 8: the Battle request hit 429/503 (Cloudflare/game throttling this IP). A
    // reload or retry right away only extends the throttle — back off, no hunt credit.
    const backoffMs = rateLimitBackoffMs();
    console.log(`[combat] Battle throttled by the server (429) — backing off ${Math.round(backoffMs / 1000)}s, no hunt credit`);
    takePackedBattleFood();
    return { outcome: 'battle:pending_verify:throttled', backoffMs };
  }

  if (battleResult === 'pending_verify') {
    // Stuck request / unverified accept: never credited. Reload resets is_processing;
    // the next cycle sees Run Away (monitored, not credited) or a clean screen.
    console.log('[combat] Battle unverified (pending) — reloading, no hunt credit');
    takePackedBattleFood();
    await navigateTo(page, config, '/combat/battle').catch(() => undefined);
    return combatRoundOutcome('battle:pending_verify:reload', config);
  }

  if (battleResult === 'heal_reserve_low') {
    // Heal refused to protect the Cooked Cod reserve: the playbook cooks before hunting.
    takePackedBattleFood();
    takeCookedCodSpentOnHeal();
    return combatRoundOutcome('battle:heal_reserve_low:cook_first', config);
  }

  const fightConfirmed =
    battleResult === 'battle_started' ||
    (!fightActiveBeforeBattle && (await isFightInProgress(page).catch(() => false)));
  if (fightConfirmed && battleResult !== 'battle_started') {
    console.log(
      `[combat] fight active after configureAndBattle=${battleResult} — treating as battle_started for outcome`,
    );
  }

  let battleMonitor: Awaited<ReturnType<typeof monitorInBattle>> = { status: 'ended' };
  if (fightConfirmed) {
    battleMonitor = await monitorInBattle(page, {
      pollMs,
      wallClockMs: battleMonitorWallClockMs(enemy.quantity),
      shouldFlee: (state) => jev.shouldFlee(state),
    });
  }
  if (battleMonitor.status === 'fled') {
    return combatRoundOutcome(
      formatHuntBattleRoundOutcome(fightConfirmed, battleResult, `flee:${battleMonitor.fleeResult}`),
      config,
    );
  }
  if (battleMonitor.status === 'timed_out' && battleMonitor.stillInBattle) {
    // Hard upper bound: wall-clock or poll cap both end in Run Away.
    console.log(`[combat] battle monitor ${battleMonitor.reason ?? 'timeout'} — running away`);
    const fleeResult = await runAway(page);
    return combatRoundOutcome(
      formatHuntBattleRoundOutcome(fightConfirmed, battleResult, `timeout_flee:${fleeResult}`),
      config,
    );
  }

  // Do not start a fresh hunt when bag food is below the cook gate — that orphans
  // hunting while the supervisor leaves combat to cook. Heal → Use spends Cooked
  // Cod after the snapshot was taken, so apply that spend before the same check.
  const cookedSpent = takeCookedCodSpentOnHeal();
  const packedFood = takePackedBattleFood();
  const snapshotCooked = cookedCodCount(ctx.snapshot.inventory);
  const worstCaseCooked = Math.max(
    0,
    snapshotCooked - cookedSpent - packedFood,
  );
  let inventoryForCookGate = inventoryAfterCookedCodSpend(ctx.snapshot.inventory, cookedSpent);
  if (shouldRefreshCookGateAfterFight(worstCaseCooked, huntCookFloor)) {
    invalidateInventoryDomCache();
    const returnPath = new URL(page.url()).pathname;
    let freshInventory: Record<string, number> | null = null;
    try {
      await navigateTo(page, ctx.config, '/inventory');
      await waitForPageReady(page, 'inventory');
      freshInventory = await scrapeInventoryFromDom(page, { forceRefresh: true }).catch(() => null);
    } catch (err) {
      console.log(`[combat] post-fight inventory read failed: ${(err as Error).message}`);
    } finally {
      if (!returnPath.includes('/inventory')) {
        await navigateTo(
          page,
          ctx.config,
          returnPath.includes('/combat') ? '/combat/battle' : returnPath,
        ).catch(() => undefined);
      }
    }
    // A partial/blank grid (slow render) must not drive the cook gate to 0.
    if (freshInventory && inventoryReadLooksCollapsed(ctx.snapshot.inventory, freshInventory)) {
      console.log('[combat] post-fight inventory read looks collapsed — using worst-case estimate');
      freshInventory = null;
    }
    if (freshInventory) {
      inventoryForCookGate = inventoryAfterCookedCodSpend(freshInventory, cookedSpent);
    } else {
      inventoryForCookGate = { ...inventoryForCookGate, 'Cooked Cod': worstCaseCooked };
    }
    const freshCooked = cookedCodCount(inventoryForCookGate);
    console.log(
      `[combat] post-fight Cooked Cod bag≈${freshCooked} (snapshot ${snapshotCooked}, packed ${packedFood}, heal ${cookedSpent})`,
    );
  }
  if (needsCookBeforeHunt(inventoryForCookGate, cookTarget, cookGateOptions)) {
    console.log('[combat] skipping Hunt More — Cooked Cod below cook target');
    if (cookedSpent > 0) {
      const cooked = cookedCodCount(inventoryForCookGate);
      console.log(
        `[combat] heal spent ${cookedSpent} Cooked Cod — bag ${cooked}/${cookTarget}`,
      );
    }
    return combatRoundOutcome(
      formatHuntBattleRoundOutcome(fightConfirmed, battleResult, 'huntMore:skipped_cook_gate'),
      config,
    );
  }

  const backlogState = await readHuntState(page).catch(() => huntState);
  if (
    shouldSkipHuntMore(
      backlogState.enemies,
      ctx.snapshot.combatLevel,
      ctx.snapshot.totalLevel,
    )
  ) {
    const backlog = enemyBacklogTotal(backlogState.enemies);
    console.log(
      `[combat] skipping Hunt More — enemy backlog ${backlog} >= cap (fight backlog first)`,
    );
    return combatRoundOutcome(
      formatHuntBattleRoundOutcome(fightConfirmed, battleResult, 'huntMore:skipped_backlog_cap'),
      config,
    );
  }

  const huntMoreResult = await huntMore(page, allowInterrupt);
  if (huntMoreResult === 'blocked_verify') {
    return combatRoundOutcome('blocked:verify', config);
  }

  return combatRoundOutcome(
    formatHuntBattleRoundOutcome(fightConfirmed, battleResult, `huntMore:${huntMoreResult}`),
    config,
  );
}

function combatExecuteResult(
  action: string,
  result: CombatRoundResult,
): { action: string; outcome: string; backoffMs?: number } {
  return {
    action,
    outcome: result.outcome,
    ...(result.backoffMs !== undefined ? { backoffMs: result.backoffMs } : {}),
  };
}

async function questTurnIn(
  page: Page,
  config: AppConfig,
  acceptedQuests: SnapshotQuest[],
  interruptGather = false,
): Promise<string> {
  const turnInReady = acceptedQuests.filter((q) => q.canTurnIn && q.tab === 'accepted');
  if (turnInReady.length === 0) {
    return 'no_turnin_ready';
  }

  if (interruptGather) {
    const nav = await navigateToQuestsInterrupting(page, config);
    if (nav === 'blocked') return 'gather_interrupt_blocked';
  }

  const outcome = await turnInCompletableQuests(page, config, acceptedQuests, {
    skipNavigate: interruptGather,
  });

  if (outcome.result === 'turned_in' && outcome.turnedInTitle) {
    return `turned_in:${outcome.turnedInTitle}`;
  }

  return 'turnin_failed';
}

async function openPendingQuestCard(
  page: Page,
  config: AppConfig,
  pendingQuests: SnapshotQuest[],
): Promise<{ opened: boolean; title?: string }> {
  const target = rankPendingQuestForAccept(pendingQuests);
  if (target && (await waitForQuestCard(page, target.title))) {
    const opened = await openQuest(page, config, target.title, { skipNavigate: true });
    if (opened !== 'failed') {
      return { opened: true, title: target.title };
    }
  }

  const ranked: SnapshotQuest[] = [];
  let remaining = [...pendingQuests];
  while (remaining.length > 0) {
    const next = rankPendingQuestForAccept(remaining);
    if (!next) break;
    ranked.push(next);
    remaining = remaining.filter((q) => q.title !== next.title);
  }

  for (const quest of ranked) {
    if (!(await waitForQuestCard(page, quest.title, 2_000))) continue;
    const opened = await openQuest(page, config, quest.title, { skipNavigate: true });
    if (opened !== 'failed') {
      return { opened: true, title: quest.title };
    }
  }

  const cards = page.getByRole('button');
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const label = (await cards.nth(i).innerText()).trim();
    if (/Hearth|Menace|Whisper|Fortune/i.test(label)) {
      await cards.nth(i).click();
      return { opened: true, title: label };
    }
  }

  return { opened: false };
}

function isTitleAccepted(title: string, acceptedQuests: SnapshotQuest[]): boolean {
  const key = normalizeQuestTitleKey(title);
  return acceptedQuests.some((q) => normalizeQuestTitleKey(q.title) === key);
}

/** Pending quests worth a talk: not already accepted and not in per-title backoff. */
export function talkEligiblePendingQuests(
  pendingQuests: SnapshotQuest[],
  acceptedQuests: SnapshotQuest[] = [],
): SnapshotQuest[] {
  return pendingQuests.filter(
    (q) => !isTitleAccepted(q.title, acceptedQuests) && !shouldSkipQuestTalkTitle(q.title),
  );
}

async function questTalkAccept(
  page: Page,
  config: AppConfig,
  pendingQuests: SnapshotQuest[],
  interruptGather = false,
  acceptedQuests: SnapshotQuest[] = [],
): Promise<string> {
  const eligible = talkEligiblePendingQuests(pendingQuests, acceptedQuests);
  if (eligible.length === 0) {
    return 'quest_talk_skipped_backoff';
  }
  const topTitle = rankPendingQuestForAccept(eligible)?.title ?? eligible[0]?.title;
  let nav: 'ok' | 'blocked' = 'ok';
  if (interruptGather) {
    nav = await navigateToQuestsInterrupting(page, config);
  } else {
    await navigateTo(page, config, '/quests');
  }
  if (nav === 'blocked') {
    return 'gather_interrupt_blocked';
  }

  await waitForQuestTabsSettled(page);
  const tab = await switchQuestTab(page, 'Pending Nearby');
  if (tab === 'no_action') {
    return 'pending_tab_missing';
  }

  let { opened, title } = await openPendingQuestCard(page, config, eligible);
  if (!opened) {
    console.log('[quest] card_not_opened — reloading quests page once');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    await waitForQuestTabsSettled(page);
    await switchQuestTab(page, 'Pending Nearby');
    ({ opened, title } = await openPendingQuestCard(page, config, eligible));
    if (!opened) {
      return topTitle ? `card_not_opened:${topTitle}` : 'card_not_opened';
    }
  }

  if (title && isTitleAccepted(title, acceptedQuests)) {
    // Opened card is a quest we already hold — talking again is a no-op, not progress.
    return `already_accepted:${title}`;
  }

  if (!(await waitForQuestDetail(page))) {
    return title ? `detail_not_ready:${title}` : 'detail_not_ready';
  }

  const talkResult = await talkQuest(page, title ? getQuestDialogueLine(title) : undefined);
  if (talkResult === 'no_action') {
    return title ? `talk:no_action:${title}` : 'talk:no_action';
  }

  if (await isTurnInEnabled(page)) {
    const turnIn = await turnInQuest(page);
    return `talk:${talkResult}:turned_in:${turnIn}`;
  }

  return `talk:${talkResult}`;
}

function gatherAction(
  id: string,
  description: string,
  skill: 'woodcutting' | 'mining' | 'fishing',
  resource: string,
  priority: number,
  extraAllowed?: (ctx: ActionAllowContext) => boolean,
): ActionDefinition {
  return {
    id,
    description,
    bootstrap: true,
    priority,
    tags: ['gather', skill],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const playbookWantsInterrupt =
        Boolean(playbook?.enabled && !playbook.complete && playbook.interruptActions.includes(id));
      const idleOrInterrupt = gatherIdle(ctx) || playbookWantsInterrupt;
      const baitOk =
        id !== 'fish_cod' ||
        ctx.snapshot.flags.hasBait ||
        Boolean(playbook?.baitOwned) ||
        Boolean(playbook?.enabled && !playbook.complete && playbook.stage === 'fish_cod');
      return (
        ctx.snapshot.flags.sessionValid &&
        idleOrInterrupt &&
        battleGuard(ctx.snapshot) !== 'battle' &&
        baitOk &&
        (extraAllowed?.(ctx) ?? true)
      );
    },
    execute: async (ctx) => {
      const skillState = await readSkillState(ctx.page, ctx.config, skill);
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const playbookInterrupt = Boolean(
        playbook?.enabled && !playbook.complete && playbook.interruptActions.includes(id),
      );
      // Stale coal busy must force Stop+Start even when already on Coal Ore.
      const staleCoalForce =
        id === 'mine_coal' && Boolean(playbook?.staleCoalGather);
      const allowInterrupt =
        staleCoalForce ||
        playbookInterrupt ||
        (await ctx.jev.shouldInterruptGather(skillState));
      const result = await restartSkillGather(ctx.page, ctx.config, {
        skill,
        resourceLabel: resource,
        allowInterrupt: ctx.forceInterrupt || allowInterrupt,
        forceRestart: staleCoalForce || Boolean(ctx.forceInterrupt && id === 'mine_coal'),
        // When forcing a stale restart, discard known busy state so gather re-reads after Stop.
        knownState: staleCoalForce ? undefined : skillState,
      });
      let outcome: string = result;
      // fish_cod missing_requirement/failed is often a UI/start/captcha issue when bait is trusted.
      const baitTrustedForFish =
        Boolean(playbook?.baitOwned) ||
        ctx.snapshot.flags.hasBait ||
        (playbook?.enabled === true && playbook.stage === 'fish_cod');
      if (id === 'fish_cod' && baitTrustedForFish && (result === 'missing_requirement' || result === 'failed')) {
        console.warn(
          `[fish_cod] ${result} while bait trusted — treating as fishing_start_failed ` +
            '(UI/captcha/Start/quantity), NOT missing bait',
        );
        outcome = 'fishing_start_failed';
      }
      if (id === 'mine_coal' && result === 'failed') {
        console.warn(
          `[mine_coal] start failed — UI/captcha/Start/quantity/replace (staleCoal=${Boolean(playbook?.staleCoalGather)})`,
        );
        outcome = 'mining_start_failed';
      }
      const backoffMs = /restarted|already_busy/i.test(outcome) ? ctx.config.pollMs * 2 : undefined;
      return {
        action: id,
        outcome,
        ...(backoffMs !== undefined ? { backoffMs } : {}),
      };
    },
  };
}

const BOOTSTRAP_ACTIONS: ActionDefinition[] = [
  {
    id: 'idle',
    description: 'Wait and backoff when no productive action is clear or session invalid',
    bootstrap: true,
    priority: 100,
    tags: ['meta'],
    safety: 'safe',
    isAllowed: () => true,
    execute: async (ctx) => ({
      action: 'idle',
      outcome: 'backoff',
      backoffMs: Math.max(ctx.config.pollMs * 2, 10_000),
    }),
  },
  {
    id: 'continue_current',
    description: 'Keep the current gather, craft, hunt, or battle running',
    bootstrap: true,
    priority: 5,
    tags: ['meta'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      return Boolean(
        ctx.snapshot.currentAction?.busy ||
          ctx.snapshot.flags.inBattle ||
          ctx.snapshot.combatPhase !== 'none' ||
          (playbook?.gatherGraceActive && playbook.stage === 'fish_cod'),
      );
    },
    execute: async (ctx) => ({
      action: 'continue_current',
      outcome: 'polling',
      backoffMs: ctx.config.pollMs,
    }),
  },
  {
    id: 'quest_turnin',
    description: 'Turn in an accepted quest that is complete',
    bootstrap: true,
    priority: 1,
    tags: ['quest'],
    safety: 'safe',
    isAllowed: (ctx) => ctx.snapshot.flags.sessionValid && hasTurnInReady(ctx),
    execute: async (ctx) => {
      const gatherState = await readGatherState(ctx.page, ctx.config);
      const interruptGather = Boolean(
        gatherState.busy ||
          gatherState.busyElsewhere ||
          ctx.snapshot.flags.gatherBusy ||
          ctx.snapshot.currentAction?.busy ||
          ctx.forceInterrupt,
      );
      return {
        action: 'quest_turnin',
        outcome: await questTurnIn(ctx.page, ctx.config, ctx.snapshot.acceptedQuests, interruptGather),
      };
    },
  },
  {
    id: 'quest_talk_accept',
    description: 'Talk to NPC and accept a pending nearby quest',
    bootstrap: true,
    priority: 15,
    tags: ['quest'],
    safety: 'safe',
    isAllowed: (ctx) => {
      if (!ctx.snapshot.flags.sessionValid || ctx.snapshot.pendingQuests.length === 0) {
        return false;
      }
      if (
        talkEligiblePendingQuests(ctx.snapshot.pendingQuests, ctx.snapshot.acceptedQuests)
          .length === 0
      ) {
        return false;
      }
      const easyPending = hasEasyCompletePendingQuest(ctx.snapshot.pendingQuests);
      return gatherIdle(ctx) || easyPending;
    },
    execute: async (ctx) => {
      const easyPending = hasEasyCompletePendingQuest(ctx.snapshot.pendingQuests);
      const gatherState = await readGatherState(ctx.page, ctx.config);
      const interruptGather =
        easyPending &&
        Boolean(
          gatherState.busy ||
            gatherState.busyElsewhere ||
            ctx.snapshot.flags.gatherBusy ||
            ctx.snapshot.currentAction?.busy,
        );
      return {
        action: 'quest_talk_accept',
        outcome: await questTalkAccept(
          ctx.page,
          ctx.config,
          ctx.snapshot.pendingQuests,
          interruptGather || ctx.forceInterrupt,
          ctx.snapshot.acceptedQuests,
        ),
      };
    },
  },
  {
    id: 'hunt_battle',
    description: 'Run combat hunt → stop → battle for kill quests and combat XP',
    bootstrap: true,
    priority: 10,
    tags: ['combat'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const combatLagging =
        (ctx.snapshot.combatLevel ?? 1) <
        Math.max(5, (ctx.snapshot.totalLevel ?? 10) * 0.2);
      return ctx.snapshot.flags.sessionValid && (hasKillQuest(ctx) || combatLagging);
    },
    execute: async (ctx) => combatExecuteResult('hunt_battle', await runCombatRound(ctx)),
  },
  gatherAction('gather_oak', 'Woodcut Oak Logs for quest mats and woodcutting XP', 'woodcutting', 'Oak Log', 25),
  gatherAction('gather_yew', 'Woodcut Yew Logs for higher woodcutting XP', 'woodcutting', 'Yew Log', 35),
  gatherAction('mine_coal', 'Mine Coal Ore for smithing mats and combat stats', 'mining', 'Coal Ore', 30),
  gatherAction('fish_cod', 'Fish Cod for food and fishing XP (needs bait)', 'fishing', 'Cod', 32),
  {
    id: 'buy_bait',
    description: 'Buy Cheap Bait at merchants (in-game gold only, 2g)',
    bootstrap: true,
    priority: 20,
    tags: ['economy', 'fishing'],
    safety: 'gold_spend',
    isAllowed: (ctx) => {
      const combatLagging =
        (ctx.snapshot.combatLevel ?? 1) <
        Math.max(5, (ctx.snapshot.totalLevel ?? 10) * 0.2);
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const playbookWantsBait =
        Boolean(playbook?.enabled && !playbook.complete && playbook.stage === 'buy_bait');
      // Never repurchase while playbook trusts bait, stage past buy_bait, or purchase cooldown active.
      // Scrape undercount after buy_bait must not bypass cooldown (trust purchased stock).
      const baitCount =
        (ctx.snapshot.inventory['Cheap Bait'] ?? 0) + (ctx.snapshot.inventory['Bait'] ?? 0);
      const baitCooldown = recentBaitPurchase(playbook?.lastBaitPurchaseAt);
      const needsBaitRestock =
        Boolean(playbook?.enabled && !playbook.complete) &&
        shouldPreferBaitRestock(playbook?.stage, baitCount, playbook?.lastBaitPurchaseAt);
      const baitTrusted =
        !needsBaitRestock &&
        (ctx.snapshot.flags.hasBait ||
          Boolean(playbook?.baitOwned) ||
          (playbook?.enabled === true &&
            !playbook.complete &&
            playbook.stage !== 'buy_bait' &&
            playbook.stage !== 'mine_coal' &&
            playbook.stage !== 'sell_half'));
      return (
        ctx.snapshot.flags.sessionValid &&
        !baitTrusted &&
        !baitCooldown &&
        // Round 7: gold floor blocks every bait buy (BAIT_GOLD_FLOOR, default 2000).
        baitPurchaseAllowedByGold(ctx.snapshot.gold) &&
        (ctx.config.buyBait ||
          hasKillQuest(ctx) ||
          combatLagging ||
          playbookWantsBait ||
          needsBaitRestock)
      );
    },
    execute: async (ctx) => ({
      action: 'buy_bait',
      // Buy a stack so one purchase covers fish_cod (inventory scrape often misses bait).
      outcome: await buyCheapBait(ctx.page, ctx.config, 50, { gold: ctx.snapshot.gold }),
    }),
  },
  {
    id: 'cook_cod',
    description: 'Cook Cod into Cooked Cod for battle food (effective HP heal)',
    bootstrap: true,
    priority: 18,
    tags: ['craft', 'combat', 'food'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const inv = ctx.snapshot.inventory;
      const hasCod = (inv['Cod'] ?? 0) >= 1 || (inv['Raw Cod'] ?? 0) >= 1;
      const hasCoal = (inv['Coal Ore'] ?? 0) >= 1;
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const cookTarget = playbook?.targets.cookMin ?? 100;
      const cooked = inv['Cooked Cod'] ?? 0;
      const needsFood = cooked < cookTarget;
      const battleRunning = battleGuard(ctx.snapshot) === 'battle';
      return (
        ctx.snapshot.flags.sessionValid &&
        gatherIdle(ctx) &&
        !battleRunning &&
        hasCod &&
        hasCoal &&
        needsFood
      );
    },
    execute: async (ctx) => {
      const guard = battleGuard(ctx.snapshot);
      if (guard === 'battle') {
        console.log('[cook] battle running (API/page) — not interrupting it with Start anyway');
        return { action: 'cook_cod', outcome: 'already_busy' as const };
      }
      if (guard === 'stale') {
        console.log('[cook] battle signal stale (expired or over BATTLE_GUARD_MAX_MS) — allowing cook');
      }
      const gatherState = await readGatherState(ctx.page, ctx.config);
      const allowInterrupt =
        ctx.forceInterrupt || (await ctx.jev.shouldInterruptGather(gatherState));
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const cookTarget = playbook?.targets.cookMin ?? 100;
      const cooked = ctx.snapshot.inventory['Cooked Cod'] ?? 0;
      const rawAvailable = Math.max(
        ctx.snapshot.inventory['Cod'] ?? 0,
        ctx.snapshot.inventory['Raw Cod'] ?? 0,
      );
      return {
        action: 'cook_cod',
        outcome: await tryCookCod(ctx.page, ctx.config, allowInterrupt, {
          cooked,
          target: cookTarget,
          rawAvailable,
        }),
      };
    },
  },
  {
    id: 'craft_if_ready',
    description: 'Smelt when Coal Ore is available and Start is enabled',
    bootstrap: true,
    priority: 22,
    tags: ['craft'],
    safety: 'safe',
    isAllowed: (ctx) =>
      ctx.snapshot.flags.sessionValid && (ctx.snapshot.inventory['Coal Ore'] ?? 0) >= 1,
    execute: async (ctx) => {
      const gatherState = await readGatherState(ctx.page, ctx.config);
      const allowInterrupt =
        ctx.forceInterrupt || (await ctx.jev.shouldInterruptGather(gatherState));
      return {
        action: 'craft_if_ready',
        outcome: await trySmeltCoal(ctx.page, ctx.config, allowInterrupt),
      };
    },
  },
  {
    id: 'sell_junk',
    description: 'Sell configured vendor-trash items (never quest mats)',
    bootstrap: true,
    priority: 40,
    tags: ['economy'],
    safety: 'inventory',
    isAllowed: (ctx) =>
      ctx.snapshot.flags.sessionValid && (hasJunk(ctx) || inventoryPressure(ctx)),
    execute: async (ctx) => ({
      action: 'sell_junk',
      outcome: await sellJunkToVendor(ctx.page, ctx.config, ctx.junkItems),
    }),
  },

  {
    id: 'sell_junk_for_gold',
    description:
      'Sell surplus gather junk (Oak, Coal, vendor trash) for gold; keep battle food and bait when fishing needs it',
    bootstrap: true,
    priority: 26,
    tags: ['economy', 'playbook'],
    safety: 'inventory',
    isAllowed: (ctx) => {
      if (!ctx.snapshot.flags.sessionValid) return false;
      // Periodic inventory sweep (loot is invisible to the snapshot scraper).
      if (getPlaybookFromSnapshot(ctx.snapshot)?.sellSurplusDue && !ctx.snapshot.flags.inBattle) {
        return true;
      }
      const sellCtx = buildSellJunkForGoldContext(ctx);
      if (!hasSurplusVendorJunk(sellCtx)) return false;
      return shouldAllowSellJunkForGold(sellCtx, ctx.config.sellGoldThreshold);
    },
    execute: async (ctx) => ({
      action: 'sell_junk_for_gold',
      outcome: await sellJunkForGold(ctx.page, ctx.config, {
        questTitles: [...ctx.snapshot.acceptedQuests, ...ctx.snapshot.pendingQuests].map((q) => q.title),
        context: buildSellJunkForGoldContext(ctx),
      }),
    }),
  },
  {
    id: 'market_sell_half',
    description:
      'Careful early-playbook sell: small vendor batches of excess mats; keep Coal for cook and Cod/Cooked Cod for battles (market price reader TBD)',
    bootstrap: true,
    priority: 28,
    tags: ['economy', 'playbook'],
    safety: 'inventory',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const stageOk =
        !playbook ||
        playbook.complete ||
        playbook.stage === 'sell_half' ||
        playbook.stage === 'sell_extras';
      return ctx.snapshot.flags.sessionValid && stageOk;
    },
    execute: async (ctx) => ({
      action: 'market_sell_half',
      outcome: await sellHalfCareful(ctx.page, ctx.config, {
        keepCoal: 100,
        maxStacks: 2,
      }),
    }),
  },
  {
    id: 'hunt_battle_batch',
    description:
      'Hunt and battle any ready enemy (prefer Rabbit) using pre-battle Cooked Cod (FOOD Add). Stops hunting at huntFoundCap and battles found enemies (battle now).',
    bootstrap: true,
    priority: 12,
    tags: ['combat', 'playbook'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const stageOk =
        !playbook ||
        playbook.complete ||
        playbook.stage === 'hunt_battle_batch' ||
        playbook.stage === 'hunt_rabbits' ||
        playbook.stage === 'complete';
      return ctx.snapshot.flags.sessionValid && stageOk;
    },
    execute: async (ctx) => combatExecuteResult('hunt_battle_batch', await runCombatRound(ctx)),
  },
  {
    // Legacy action id kept so older decisions / filters still resolve during rollout.
    id: 'hunt_rabbits',
    description: 'Deprecated alias for hunt_battle_batch',
    bootstrap: true,
    priority: 12,
    tags: ['combat', 'playbook', 'legacy'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const stageOk =
        !playbook ||
        playbook.complete ||
        playbook.stage === 'hunt_battle_batch' ||
        playbook.stage === 'hunt_rabbits' ||
        playbook.stage === 'complete';
      return ctx.snapshot.flags.sessionValid && stageOk;
    },
    execute: async (ctx) => combatExecuteResult('hunt_rabbits', await runCombatRound(ctx)),
  },
  {
    id: 'manage_pets',
    description:
      'Pets maintenance: claim / feed / battle / sleep (OK while busy); equip only when character is idle',
    bootstrap: true,
    priority: 16,
    tags: ['pets', 'playbook'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const stageOk =
        !playbook ||
        playbook.complete ||
        playbook.stage === 'manage_pets' ||
        playbook.stage === 'complete';
      // Maintenance is allowed while gatherBusy/inBattle; equip is gated inside managePets.
      return ctx.snapshot.flags.sessionValid && stageOk;
    },
    execute: async (ctx) => ({
      action: 'manage_pets',
      outcome: await managePets(ctx.page, ctx.config, { allowEquip: gatherIdle(ctx) }),
      backoffMs: Math.max(ctx.config.pollMs * 2, 5_000),
    }),
  },
  {
    id: 'equip_pet',
    description: 'Equip a pet for boost — only when character is idle (not gathering/acting)',
    bootstrap: true,
    priority: 17,
    tags: ['pets', 'playbook'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      const stageOk =
        !playbook ||
        playbook.complete ||
        playbook.stage === 'manage_pets' ||
        playbook.stage === 'complete';
      return ctx.snapshot.flags.sessionValid && stageOk && gatherIdle(ctx);
    },
    execute: async (ctx) => ({
      action: 'equip_pet',
      outcome: await equipPet(ctx.page, ctx.config),
      backoffMs: Math.max(ctx.config.pollMs * 2, 5_000),
    }),
  },
];

/** Exploration action — not bootstrap; extends progressive loops as zones unlock. */
const EXPLORATION_ACTIONS: ActionDefinition[] = [
  {
    id: 'explore_map',
    description: 'Open the map modal and read zone/location data (read-only exploration)',
    bootstrap: false,
    priority: 90,
    tags: ['exploration'],
    safety: 'safe',
    isAllowed: (ctx) => {
      const playbook = getPlaybookFromSnapshot(ctx.snapshot);
      if (playbook?.enabled && !playbook.complete && playbook.stage !== 'explore_map' && playbook.stage !== 'complete') {
        // Still allowed but deprioritized via playbook filter; keep available for Jev.
      }
      return ctx.snapshot.flags.sessionValid;
    },
    execute: async (ctx) => {
      const mapBtn = ctx.page.getByRole('button', { name: /show-map|map/i });
      if (await mapBtn.count() > 0) {
        await mapBtn.first().click({ timeout: 3000 }).catch(() => undefined);
      }
      const text = await ctx.page.locator('body').innerText();
      const zones = text.match(/Bluebell Hollow|The Citadel|[A-Z][a-z]+ Hollow/g) ?? [];
      return {
        action: 'explore_map',
        outcome: `zones:${zones.slice(0, 5).join(',') || 'none'}`,
        backoffMs: ctx.config.pollMs,
      };
    },
  },
];

/** Register bootstrap + built-in exploration actions. Call registerDiscoveredAction() to extend. */
export function registerBootstrapActions(): void {
  for (const def of [...BOOTSTRAP_ACTIONS, ...EXPLORATION_ACTIONS]) {
    registerAction(def);
  }
}

/** Hook for overseer / future modules to register newly scriptable loops at runtime. */
export function registerDiscoveredAction(def: ActionDefinition): void {
  registerAction({ ...def, bootstrap: false });
}
