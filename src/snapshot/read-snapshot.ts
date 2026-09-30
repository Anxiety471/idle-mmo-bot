import { parseCurrentActionProducedCount } from '../deterministic/gather.js';
import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { CombatPhase, GameSnapshot, SnapshotQuest, SkillId } from '../types.js';
import { navigateTo } from '../browser.js';
import { waitForPageReady } from '../browser/page-ready.js';
import {
  applyCombatLevelSanity,
  applyInventorySanity,
  getSnapshotHealthState,
  noteSnapshotHealthFromSnapshot,
  setSnapshotHealthState,
} from './snapshot-health.js';
import {
  readSkillState,
  switchQuestTab,
  waitForQuestTabsSettled,
} from '../deterministic/index.js';
import { mapEnricher } from '../autopilot/snapshot-enrichers.js';
import { isQuestProgressMet } from '../deterministic/quest-accept.js';
import {
  buildInventoryMap,
  detectHasBait,
  scrapeInventoryFromDom,
} from './inventory-scrape.js';
import { parseHuntMetrics } from '../deterministic/combat.js';
import { applyPublicApiToSnapshot } from './merge-public-api.js';
import { loadIdleMmoApiConfig, readPublicApi } from '../api/idle-mmo-api.js';
import { noteBusySkillForInventoryCache } from './inventory-scrape.js';

const SKILL_IDS: SkillId[] = [
  'woodcutting',
  'mining',
  'fishing',
  'alchemy',
  'smelting',
  'cooking',
  'forge',
  'construction',
];

async function bodyText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

function parseNumber(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseSkillLevels(text: string): Partial<Record<SkillId, number>> {
  const levels: Partial<Record<SkillId, number>> = {};
  for (const skill of SKILL_IDS) {
    const pattern = new RegExp(`${skill}\\s*(?:Lv\\.?|Level)?\\s*(\\d+)`, 'i');
    const level = parseNumber(text, pattern);
    if (level !== undefined) levels[skill] = level;
  }
  return levels;
}

/** Normalize apostrophe/case variants ("A Ducks Whisper" vs "A Duck's Whisper"). */
export function normalizeQuestTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUEST_TITLE_SKIP = new Set(
  [
    'overview',
    'talk',
    'turn in',
    'complete',
    'quests',
    'accepted',
    'pending nearby',
    'completed',
    'search',
    'character',
    'map',
  ].map((s) => normalizeQuestTitleKey(s)),
);

function parseQuestCards(text: string, tab: SnapshotQuest['tab']): SnapshotQuest[] {
  const quests: SnapshotQuest[] = [];
  const seen = new Set<string>();

  const cardPattern =
    /([A-Z][A-Za-z'’\s]{2,48})\s*(?:\(([\d,]+)\))?\s*[\n\r]+\s*((?:[A-Za-z][\w' -]{1,30}\s+)?\d+\s*\/\s*\d+)/g;
  for (const match of text.matchAll(cardPattern)) {
    const title = match[1].trim();
    const key = normalizeQuestTitleKey(title);
    if (QUEST_TITLE_SKIP.has(key) || seen.has(key)) continue;
    seen.add(key);
    const progress = match[3]?.trim();
    const canTurnIn =
      (/Turn In/i.test(text) && text.includes(title)) ||
      (tab === 'accepted' && isQuestProgressMet(progress));
    quests.push({ title, progress, canTurnIn, tab });
  }

  // Fallback: title immediately followed by progress on one line.
  const inlinePattern = /([A-Z][A-Za-z'’\s]{2,48})\s+((?:[A-Za-z][\w' -]{1,30}\s+)?\d+\s*\/\s*\d+)/g;
  for (const match of text.matchAll(inlinePattern)) {
    const title = match[1].trim();
    const key = normalizeQuestTitleKey(title);
    if (QUEST_TITLE_SKIP.has(key) || seen.has(key)) continue;
    seen.add(key);
    const progress = match[2]?.trim();
    quests.push({
      title,
      progress,
      canTurnIn:
        (/Turn In/i.test(text) && text.includes(title)) ||
        (tab === 'accepted' && isQuestProgressMet(progress)),
      tab,
    });
  }

  return quests;
}

function detectCombatPhase(text: string, path: string): CombatPhase {
  if (!path.includes('/combat')) return 'none';
  if (text.includes('Run Away')) return 'battle';
  if (text.includes('STANCE') && text.includes('Battle')) return 'enemy_select';
  if ((text.includes('Stop') || text.includes('Cancel Hunt')) && text.includes('Total Enemies Found')) {
    return 'hunt';
  }
  if (text.includes('Start Hunt') || text.includes('Hunt More')) return 'none';
  return 'none';
}

function detectLocation(text: string): string {
  const zoneMatch = text.match(/(?:Current|Zone|Location)[:\s]+([A-Za-z' -]+)/i);
  if (zoneMatch?.[1]) return zoneMatch[1].trim();
  if (text.includes('Bluebell Hollow')) return 'Bluebell Hollow';
  return 'unknown';
}

async function readQuestsForTab(
  page: Page,
  config: AppConfig,
  tab: 'Accepted' | 'Pending Nearby',
  tabKey: SnapshotQuest['tab'],
): Promise<SnapshotQuest[]> {
  await navigateTo(page, config, '/quests');
  await waitForQuestTabsSettled(page);
  await switchQuestTab(page, tab);
  const text = await bodyText(page);
  return parseQuestCards(text, tabKey);
}

function logSnapshotStep(step: string, startedAt: number): void {
  const ms = Date.now() - startedAt;
  console.log(`[snapshot] step=${step} ms=${ms}`);
}

/** Build a structured GameSnapshot from live Playwright page state. */
export async function readGameSnapshot(page: Page, config: AppConfig): Promise<GameSnapshot> {
  const snapshotStarted = Date.now();
  let snapshotDegraded = false;
  const path = new URL(page.url()).pathname;
  let text = await bodyText(page);

  let apiBusySkill: string | undefined;
  const apiLoaded = loadIdleMmoApiConfig();
  if (apiLoaded.enabled) {
    const apiStep = Date.now();
    try {
      const apiRead = await readPublicApi();
      if (apiRead.enabled && apiRead.read.patch.currentAction?.busy) {
        apiBusySkill = apiRead.read.patch.currentAction.skill;
      }
      if (apiRead.enabled && noteBusySkillForInventoryCache(apiBusySkill ?? null)) {
        console.log(`[snapshot] busy skill changed → ${apiBusySkill ?? 'idle'}; inventory cache dropped`);
      }
    } catch {
      // Best-effort — DOM scrape continues.
    }
    logSnapshotStep('public_api_prefetch', apiStep);
  }

  const questStep = Date.now();
  const acceptedQuests = await readQuestsForTab(page, config, 'Accepted', 'accepted');
  const pendingQuests = await readQuestsForTab(page, config, 'Pending Nearby', 'pending');
  logSnapshotStep('quests', questStep);

  const inventoryStep = Date.now();
  await navigateTo(page, config, '/inventory');
  await waitForPageReady(page, 'inventory');
  const inventoryText = await bodyText(page);
  const domInventory = await scrapeInventoryFromDom(page).catch(() => ({}));
  let inventory = buildInventoryMap(inventoryText, domInventory);
  const healthBefore = getSnapshotHealthState();
  const invSanity = applyInventorySanity(healthBefore, inventory);
  inventory = invSanity.inventory;
  snapshotDegraded = invSanity.degraded;
  setSnapshotHealthState(invSanity.state);
  const hasBait = detectHasBait(inventory, inventoryText);
  const baitCountUntrusted = invSanity.degraded;
  logSnapshotStep('inventory', inventoryStep);

  const skillStep = Date.now();
  const gatherState = await readSkillState(page, config, 'woodcutting', {
    probeOtherSkills: !apiBusySkill,
  });
  logSnapshotStep('skill_state', skillStep);
  const gatherBusy = gatherState.busy || Boolean(gatherState.busyElsewhere);

  let combatPhase: CombatPhase = 'none';
  let combatText = text;
  if (!path.includes('/combat')) {
    await navigateTo(page, config, '/combat/battle');
    combatText = await bodyText(page);
  }
  combatPhase = detectCombatPhase(combatText, '/combat/battle');
  const inBattle = combatText.includes('Run Away');
  const huntMetrics = parseHuntMetrics(combatText);

  await navigateTo(page, config, '/profile');
  await waitForPageReady(page, 'profile');
  text = await bodyText(page);

  const totalLevel = parseNumber(text, /Total\s*Lv\.?\s*(\d+)/i);
  const combatParsed = parseNumber(text, /Combat\s*(?:Lv\.?)?\s*(\d+)/i);
  const combatSanity = applyCombatLevelSanity(getSnapshotHealthState(), combatParsed);
  const combatLevel = combatSanity.combatLevel;
  if (combatSanity.degraded) snapshotDegraded = true;
  setSnapshotHealthState(combatSanity.state);
  const gold = parseNumber(text, /Gold\s+([\d,]+)/i);
  const tokens = parseNumber(text, /Tokens?\s+(\d+)/i);
  const skillLevels = parseSkillLevels(text);
  const bankNearby = !/No Bank Nearby/i.test(text);

  const producedCount = gatherState.busy
    ? gatherState.producedCount ?? parseCurrentActionProducedCount(gatherState.pageText)
    : gatherState.busyElsewhere?.producedCount;
  const currentAction = gatherBusy
    ? {
        busy: true,
        skill: gatherState.busy ? gatherState.skill : gatherState.busyElsewhere?.skill,
        resource: gatherState.busy
          ? gatherState.currentResource
          : gatherState.busyElsewhere?.resource,
        label: gatherState.busyElsewhere
          ? `${gatherState.busyElsewhere.skill} active`
          : gatherState.currentResource,
        producedCount,
      }
    : combatPhase !== 'none' || inBattle
      ? { busy: true, label: inBattle ? 'battle' : `combat:${combatPhase}` }
      : undefined;

  const sessionValid = !/Register|Sign up|session expired/i.test(text);

  let snapshot: GameSnapshot = {
    location: detectLocation(text),
    pagePath: path,
    totalLevel,
    combatLevel,
    gold,
    tokens,
    currentAction,
    skillLevels,
    inventory,
    acceptedQuests,
    pendingQuests,
    combatPhase,
    totalEnemiesFound: huntMetrics.totalEnemiesFound,
    enemiesRemaining: huntMetrics.enemiesRemaining,
    features: {
      meditationLocked: /Meditation/i.test(text) && /Total Lv\.?\s*50|Lv\.?\s*50/i.test(text),
      slayerMentioned: /slayer/i.test(text),
    },
    discovered: { features: [], unregisteredRoutes: [] },
    extensions: {},
    flags: {
      hasBait,
      bankNearby,
      gatherBusy,
      inBattle,
      sessionValid,
      snapshotDegraded: snapshotDegraded || undefined,
      baitCountUntrusted: baitCountUntrusted || undefined,
    },
  };

  try {
    const mapPatch = await mapEnricher.enrich(page, config, snapshot);
    snapshot = {
      ...snapshot,
      ...mapPatch,
      zones: mapPatch.zones ?? snapshot.zones,
      features: { ...snapshot.features, ...mapPatch.features },
    };
  } catch {
    // Map enricher is best-effort.
  }

  const merged = await applyPublicApiToSnapshot(snapshot);
  noteSnapshotHealthFromSnapshot(merged);
  logSnapshotStep('total', snapshotStarted);
  return merged;
}
