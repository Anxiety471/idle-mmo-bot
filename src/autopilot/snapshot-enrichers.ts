import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { GameSnapshot, SnapshotZone } from '../types.js';
import { navigateTo } from '../browser.js';

export interface SnapshotEnricher {
  name: string;
  enrich(page: Page, config: AppConfig, snapshot: GameSnapshot): Promise<Partial<GameSnapshot>>;
}

function parseZones(text: string): SnapshotZone[] {
  const zones: SnapshotZone[] = [];
  const known = [
    { name: 'Bluebell Hollow', level: 1 },
    { name: 'The Citadel', level: 100 },
  ];
  for (const zone of known) {
    if (text.includes(zone.name)) {
      zones.push({ name: zone.name, levelReq: zone.level, current: text.includes(`Current`) && text.includes(zone.name) });
    }
  }
  const currentMatch = text.match(/(?:Current|You are in)[:\s]+([A-Za-z' -]+)/i);
  if (currentMatch?.[1]) {
    const name = currentMatch[1].trim();
    if (!zones.some((z) => z.name === name)) {
      zones.push({ name, current: true });
    }
  }
  return zones;
}

/** Profile / levels / gold / tokens. */
export const profileEnricher: SnapshotEnricher = {
  name: 'profile',
  async enrich(page, config, snapshot) {
    await navigateTo(page, config, '/profile');
    const text = await page.locator('body').innerText();
    const totalLevel = text.match(/Total\s*Lv\.?\s*(\d+)/i)?.[1];
    const combatLevel = text.match(/Combat\s*(?:Lv\.?)?\s*(\d+)/i)?.[1];
    const gold = text.match(/Gold\s+([\d,]+)/i)?.[1];
    const tokens = text.match(/Tokens?\s+(\d+)/i)?.[1];

    return {
      totalLevel: totalLevel ? Number.parseInt(totalLevel, 10) : snapshot.totalLevel,
      combatLevel: combatLevel ? Number.parseInt(combatLevel, 10) : snapshot.combatLevel,
      gold: gold ? Number.parseInt(gold.replace(/,/g, ''), 10) : snapshot.gold,
      tokens: tokens ? Number.parseInt(tokens, 10) : snapshot.tokens,
      flags: {
        ...snapshot.flags,
        bankNearby: !/No Bank Nearby/i.test(text),
        sessionValid: !/Register|Sign up|session expired/i.test(text),
      },
      features: {
        ...snapshot.features,
        meditationLocked: /Meditation/i.test(text) && /Total Lv\.?\s*50|Lv\.?\s*50/i.test(text),
        slayerMentioned: /slayer/i.test(text),
      },
    };
  },
};

/** Map modal — zones and current location (read-only). */
export const mapEnricher: SnapshotEnricher = {
  name: 'map',
  async enrich(page, _config, snapshot) {
    const mapBtn = page.getByRole('button', { name: /show-map|map/i });
    if (await mapBtn.count() > 0) {
      await mapBtn.first().click({ timeout: 3000 }).catch(() => undefined);
    }
    const text = await page.locator('body').innerText();
    const zones = parseZones(text);
    const location = zones.find((z) => z.current)?.name ?? snapshot.location;
    return {
      location,
      zones: zones.length > 0 ? zones : snapshot.zones,
      features: { ...snapshot.features, mapVisible: zones.length > 0 },
    };
  },
};

export const SNAPSHOT_ENRICHERS: SnapshotEnricher[] = [profileEnricher, mapEnricher];

export async function applyEnrichers(
  page: Page,
  config: AppConfig,
  base: GameSnapshot,
): Promise<GameSnapshot> {
  let snapshot = base;
  for (const enricher of SNAPSHOT_ENRICHERS) {
    try {
      const patch = await enricher.enrich(page, config, snapshot);
      snapshot = { ...snapshot, ...patch, flags: { ...snapshot.flags, ...patch.flags }, features: { ...snapshot.features, ...patch.features } };
    } catch {
      // Best-effort enrichers — core snapshot still usable.
    }
  }
  return snapshot;
}
