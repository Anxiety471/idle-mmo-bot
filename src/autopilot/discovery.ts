import type { Page } from 'playwright';
import type { DiscoveredFeature, GameSnapshot } from '../types.js';
import { listActions } from './action-registry.js';

const NAV_LABEL_PATTERN =
  /\b(Skills|Combat|Inventory|Quests|Merchants|Profile|Bank|Market|Party|Tavern|Campaign|Pets|Meditation|Map|Equipment)\b/gi;

const ROUTE_HINTS: Array<{ pattern: RegExp; label: string; route: string }> = [
  { pattern: /tavern/i, label: 'Tavern', route: '/tavern' },
  { pattern: /campaign/i, label: 'Campaign', route: '/campaign' },
  { pattern: /pets?/i, label: 'Pets', route: '/pets' },
  { pattern: /meditation/i, label: 'Meditation', route: '/skills/view/meditation' },
  { pattern: /slayer/i, label: 'Slayer', route: '/combat/slayer' },
  { pattern: /show-map|map modal/i, label: 'Map', route: 'show-map' },
];

const IMPLEMENTED_ROUTE_PREFIXES = [
  '/skills/view/',
  '/combat/battle',
  '/quests',
  '/inventory',
  '/merchants',
  '/profile',
  '/equipment',
  '/bank',
  '/market',
];

function isRouteCovered(route: string, registeredIds: Set<string>): boolean {
  if (registeredIds.has('explore_map') && route === 'show-map') return true;
  return IMPLEMENTED_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix));
}

/**
 * Scan visible UI for features/routes not yet wired into the action registry.
 * Logs hints for overseer agents; does not invent clicks on unknown flows.
 */
export async function discoverFeatures(page: Page): Promise<DiscoveredFeature[]> {
  const text = await page.locator('body').innerText();
  const registered = new Set(listActions().map((a) => a.id));
  const found: DiscoveredFeature[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(NAV_LABEL_PATTERN)) {
    const label = match[1];
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const hint = ROUTE_HINTS.find((h) => h.pattern.test(label));
    const route = hint?.route ?? `/${key}`;
    if (isRouteCovered(route, registered)) continue;

    found.push({
      label,
      route,
      scriptable: false,
      note: 'Visible in UI but no registered autopilot action yet',
    });
  }

  for (const hint of ROUTE_HINTS) {
    if (!hint.pattern.test(text)) continue;
    if (isRouteCovered(hint.route, registered)) continue;
    const key = hint.route;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      label: hint.label,
      route: hint.route,
      scriptable: hint.route === 'show-map',
      note: hint.route === 'show-map' ? 'Use explore_map action' : 'Needs deterministic driver',
    });
  }

  return found;
}

export function mergeDiscoveryIntoSnapshot(
  snapshot: GameSnapshot,
  discovered: DiscoveredFeature[],
): GameSnapshot {
  return {
    ...snapshot,
    discovered: {
      ...snapshot.discovered,
      features: discovered,
      unregisteredRoutes: discovered.map((d) => d.route),
    },
  };
}

const lastDiscoveryLog = new Map<string, number>();
const DISCOVERY_LOG_COOLDOWN_MS = 300_000;

/** Log newly seen unregistered features (throttled) for overseer follow-up. */
export function logDiscoveries(discovered: DiscoveredFeature[], cycle: number): void {
  const now = Date.now();
  for (const feature of discovered) {
    if (feature.scriptable) continue;
    const last = lastDiscoveryLog.get(feature.route) ?? 0;
    if (now - last < DISCOVERY_LOG_COOLDOWN_MS) continue;
    lastDiscoveryLog.set(feature.route, now);
    console.log(
      `[autopilot:discover] cycle=${cycle} unregistered feature "${feature.label}"` +
        ` route=${feature.route} — ${feature.note}`,
    );
  }
}
