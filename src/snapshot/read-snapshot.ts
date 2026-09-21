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


const KNOWN_INV_ITEMS = [
  'Coal Ore',
  'Coal',
  'Oak Log',
  'Yew Log',
  'Cheap Bait',
  'Cod',
  'Raw Cod',
  'Cooked Cod',
  'Burnt Cod',
  'Salmon',
  'Cooked Salmon',
  'Burnt Salmon',
  'Tuna',
  'Cooked Tuna',
];

/** Icon-heavy inventory: scrape alt/title/aria-label and click slots for detail panel. */
async function scrapeInventoryFromDom(page: Page): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  try {
  // String body avoids tsx/esbuild injecting __name into the browser context.
  const fromDom = (await page.evaluate(
    `([known]) => {
      const out = {};
      const bump = (name, qty) => {
        if (!name || !Number.isFinite(qty) || qty <= 0) return;
        out[name] = Math.max(out[name] || 0, qty);
      };
      const parseQty = (raw) => {
        if (!raw) return 0;
        const t = String(raw).trim().replace(/,/g, '');
        const mk = t.match(/^(\d+(?:\.\d+)?)[kK]$/);
        if (mk) return Math.round(Number.parseFloat(mk[1]) * 1000);
        const m = t.match(/^(\d+)$/);
        return m ? Number.parseInt(m[1], 10) : 0;
      };
      const nodes = Array.from(document.querySelectorAll('[title], img[alt], [aria-label]'));
      for (const el of nodes) {
        const label =
          el.getAttribute('title') ||
          el.getAttribute('alt') ||
          el.getAttribute('aria-label') ||
          '';
        const name = label.trim();
        if (!name || name.length < 2) continue;
        const matched = known.find((k) => {
          const kl = String(k).toLowerCase();
          const nl = name.toLowerCase();
          if (nl === kl) return true;
          if (kl.length <= 3) return false; // avoid Cod⊂Code
          return nl.includes(kl);
        });
        if (!matched) continue;
        const root = el.closest('button, [role="button"], a, li, div');
        const text = (root && root.textContent ? root.textContent : '').replace(/\s+/g, ' ');
        const qtyMatch = text.match(/(\d+(?:\.\d+)?[kK]?)/);
        bump(matched, parseQty(qtyMatch && qtyMatch[1]) || 1);
      }
      return out;
    }`,
    [KNOWN_INV_ITEMS] as [string[]],
  )) as Record<string, number>;
  Object.assign(counts, fromDom);
  } catch {
    // DOM evaluate best-effort
  }

  try {
    const buttons = page.getByRole('button');
    const count = await buttons.count();
    let inspected = 0;
    for (let i = 0; i < count && inspected < 24; i++) {
      const btn = buttons.nth(i);
      const label = (await btn.innerText().catch(() => '')).trim();
      if (/^Empty$/i.test(label)) continue;
      const aria = (await btn.getAttribute('aria-label').catch(() => '')) ?? '';
      const title = (await btn.getAttribute('title').catch(() => '')) ?? '';
      const looksLikeSlot =
        !label ||
        /^(\d+(?:\.\d+)?[kK]?)$/.test(label) ||
        KNOWN_INV_ITEMS.some((k) => label.includes(k) || aria.includes(k) || title.includes(k)) ||
        /bait|cod|coal|log|ore/i.test(`${label} ${aria} ${title}`);
      if (!looksLikeSlot) continue;
      await btn.click({ timeout: 1500 }).catch(() => undefined);
      await page.waitForTimeout(200);
      const body = await page.locator('body').innerText();
      for (const name of KNOWN_INV_ITEMS) {
        const nameRe = new RegExp(`(?:^|[^A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z]|$)`);
        if (!nameRe.test(body)) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped + '[^0-9]{0,40}([0-9]+(?:[.,][0-9]+)?[kK]?)', 'i');
        const m = body.match(re);
        let qty = 1;
        if (m?.[1]) {
          const raw = m[1].replace(/,/g, '');
          if (/k$/i.test(raw)) qty = Math.round(Number.parseFloat(raw) * 1000);
          else qty = Number.parseInt(raw, 10) || 1;
        }
        counts[name] = Math.max(counts[name] ?? 0, qty);
      }
      inspected += 1;
    }
  } catch {
    // best-effort
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
  const inventoryRaw = {
    ...parseInventoryCounts(inventoryText),
    ...(await scrapeInventoryFromDom(page)),
  };
  // Drop false positives (e.g. "Code of Conduct" → Cod).
  const inventory: Record<string, number> = {};
  for (const [key, qty] of Object.entries(inventoryRaw)) {
    if (/^cod$/i.test(key) && !/raw\s*cod|cooked\s*cod|burnt\s*cod/i.test(key)) {
      // keep only if exact Cod and qty looks like a stack, not page chrome
      if (qty >= 200) continue;
    }
    if (/code of conduct|cookies|credits|monetisation/i.test(key)) continue;
    inventory[key] = qty;
  }
  // Inventory is icon-heavy; also accept numeric badges near bait names or prior merchant buys.
  const hasBait =
    (inventory['Cheap Bait'] ?? 0) > 0 ||
    /Cheap\s*Bait/i.test(inventoryText) ||
    /\b(?:cheap\s+)?bait\b/i.test(inventoryText) ||
    Object.keys(inventory).some((k) => /cheap\s*bait|^bait$/i.test(k));

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
