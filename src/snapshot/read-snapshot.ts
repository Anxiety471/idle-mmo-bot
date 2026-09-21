import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { CombatPhase, GameSnapshot, SnapshotQuest, SkillId } from '../types.js';
import { navigateTo } from '../browser.js';
import {
  readSkillState,
  switchQuestTab,
  waitForQuestTabsSettled,
} from '../deterministic/index.js';
import { mapEnricher } from '../autopilot/snapshot-enrichers.js';

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

function parseInventoryCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const patterns = [
    /([A-Za-z][A-Za-z' -]{1,30})\s+x\s*(\d+)/g,
    /([A-Za-z][A-Za-z' -]{1,30})\s+(\d+)\s*$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1].trim();
      const qty = Number.parseInt(match[2], 10);
      if (!name || !Number.isFinite(qty)) continue;
      counts[name] = Math.max(counts[name] ?? 0, qty);
    }
  }
  return counts;
}

function parseQuestCards(text: string, tab: SnapshotQuest['tab']): SnapshotQuest[] {
  const quests: SnapshotQuest[] = [];
  const knownTitles = [
    'Wood for the Hearth',
    'Goblin Menace',
    "A Duck's Whisper",
    "A Duck's Whisper",
    "A Rabbits Fortune",
    "A Rabbit's Fortune",
  ];

  for (const title of knownTitles) {
    if (!text.includes(title)) continue;
    const progressMatch = text.match(
      new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,200}?(\\d+\\s*/\\s*\\d+)`, 'i'),
    );
    const canTurnIn = /Turn In/i.test(text) && text.includes(title);
    quests.push({
      title,
      progress: progressMatch?.[1]?.trim(),
      canTurnIn,
      tab,
    });
  }

  return quests;
}

function detectCombatPhase(text: string, path: string): CombatPhase {
  if (!path.includes('/combat')) return 'none';
  if (text.includes('Run Away')) return 'battle';
  if (text.includes('STANCE') && text.includes('Battle')) return 'enemy_select';
  if (text.includes('Stop') && text.includes('Total Enemies Found')) return 'hunt';
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

/** Build a structured GameSnapshot from live Playwright page state. */
export async function readGameSnapshot(page: Page, config: AppConfig): Promise<GameSnapshot> {
  const path = new URL(page.url()).pathname;
  let text = await bodyText(page);

  const acceptedQuests = await readQuestsForTab(page, config, 'Accepted', 'accepted');
  const pendingQuests = await readQuestsForTab(page, config, 'Pending Nearby', 'pending');

  await navigateTo(page, config, '/inventory');
  const inventoryText = await bodyText(page);
  const inventory = parseInventoryCounts(inventoryText);
  const hasBait = (inventory['Cheap Bait'] ?? 0) > 0 || /Cheap Bait/i.test(inventoryText);

  const gatherState = await readSkillState(page, config, 'woodcutting', {
    probeOtherSkills: true,
  });
  const gatherBusy = gatherState.busy || Boolean(gatherState.busyElsewhere);

  let combatPhase: CombatPhase = 'none';
  let combatText = text;
  if (!path.includes('/combat')) {
    await navigateTo(page, config, '/combat/battle');
    combatText = await bodyText(page);
  }
  combatPhase = detectCombatPhase(combatText, '/combat/battle');
  const inBattle = combatText.includes('Run Away');

  await navigateTo(page, config, '/profile');
  text = await bodyText(page);

  const totalLevel = parseNumber(text, /Total\s*Lv\.?\s*(\d+)/i);
  const combatLevel = parseNumber(text, /Combat\s*(?:Lv\.?)?\s*(\d+)/i);
  const gold = parseNumber(text, /Gold\s+([\d,]+)/i);
  const tokens = parseNumber(text, /Tokens?\s+(\d+)/i);
  const skillLevels = parseSkillLevels(text);
  const bankNearby = !/No Bank Nearby/i.test(text);

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

  return snapshot;
}
