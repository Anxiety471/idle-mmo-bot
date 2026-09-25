export {
  readGatherState,
  readSkillState,
  findActiveGatherOnOtherSkill,
  waitUntilIdle,
  restartGather,
  restartSkillGather,
  type ReadSkillStateOptions,
  type RestartGatherOptions,
  type RestartSkillOptions,
} from './gather.js';

export {
  getSkillConfig,
  resolveResource,
  GATHER_SKILL_IDS,
  SKILL_CONFIGS,
  type SkillConfig,
  type SkillId,
} from './skills.js';

export {
  startHunt,
  ensureHuntActive,
  readHuntState,
  stopHunt,
  configureAndBattle,
  DETERMINISTIC_MAX_ENEMIES,
  deterministicStance,
  readBattleState,
  readPageTextBounded,
  parsePlayerHpPercent,
  monitorInBattle,
  battleMonitorWallClockMs,
  BATTLE_TEXT_READ_TIMEOUT_MS,
  BATTLE_MONITOR_MAX_POLLS,
  runAway,
  huntMore,
  waitForEnemies,
  waitForEnemyCards,
  openEnemiesNearbyPanel,
  prepareEnemyBattleSelection,
  parseHuntMetrics,
  huntingMetricsSection,
  hasHuntProgress,
  hasEnemySelectionReady,
  hasPostHuntEnemySelectionReady,
  pickBattleEnemy,
  enemyNameFromImageSrc,
  isIdleBattleScreen,
  isIdleBattleText,
  isHuntActivelyRunning,
} from './combat.js';

export {
  readQuestState,
  openQuest,
  switchQuestTab,
  waitForQuestTabsSettled,
  waitForQuestCard,
  waitForQuestDetail,
  navigateToQuestsInterrupting,
  talkQuest,
  turnInQuest,
  turnInQuestWhenReady,
  turnInCompletableQuests,
  readQuestProgress,
  isTurnInEnabled,
  questTitlePattern,
  sortTurnInCandidates,
  type OpenQuestOptions,
  type TurnInQuestOptions,
  type TurnInQuestOutcome,
  type TurnInCompletableQuestsOptions,
  type TurnInCompletableQuestsOutcome,
} from './quest.js';

export {
  HEARTH_QUEST,
  GOBLIN_QUEST,
  HEARTH_ACCEPT_DIALOGUE,
  parseQuestProgressFraction,
  isQuestProgressMet,
  rankPendingQuestForAccept,
  hasEasyCompletePendingQuest,
  getQuestDialogueLine,
} from './quest-accept.js';

export { buyCheapBait } from './merchant.js';
export { sellJunk, sellJunkToVendor, sellHalfCareful } from './inventory.js';
export {
  parseSellGoldThreshold,
  hasSurplusVendorJunk,
  shouldAllowSellJunkForGold,
  needsBaitProtection,
  buildSellItemHints,
  sellJunkForGold,
  type SellJunkForGoldContext,
  type SellJunkForGoldOptions,
  type SellJunkProtectionOptions,
} from './sell-junk-for-gold.js';
export { trySmeltCoal } from './craft.js';
export { huntFoundCap, shouldHardStopHunt } from './hunt-cap.js';
export {
  isHumanCheckPresent,
  solveHumanCaptchaIfPresent,
  attemptHumanVerify,
  parseEmojiPromptTarget,
  emojiForPromptName,
  areEmojiChoicesBlank,
  type HumanVerifyResult,
  type SolveHumanCaptchaOptions,
} from './human-check.js';
export {
  MIN_POLL_MS,
  DEFAULT_POLL_MS,
  MAX_VERIFY_ATTEMPTS_PER_CYCLE,
  effectivePollMs,
  verifyBackoffMs,
  createVerifyBudget,
  canAttemptVerify,
  recordVerifyAttempt,
  type VerifyBudget,
} from './poll-interval.js';
export {
  selectBattleFood,
  inventoryHasBattleFood,
  inventoryCanCookBattleFood,
  cookedCodCount,
  needsCookBeforeHunt,
  inventoryAfterCookedCodSpend,
  takeCookedCodSpentOnHeal,
} from './combat.js';
export { tryCookCod, cookInterruptDecision } from './cook.js';
export { equipPet, maintainPets, managePets } from './pets.js';
export type { ManagePetsOptions, PetsStepResult } from './pets.js';
