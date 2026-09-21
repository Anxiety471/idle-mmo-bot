/**
 * Skill gather configuration derived from live-tested UI (Sep 2025).
 * Routes: /skills/view/<skill> (note: /skills alone 404s).
 */

export type SkillId = 'woodcutting' | 'mining' | 'fishing';

export interface SkillConfig {
  id: SkillId;
  /** Path segment after BASE_URL, e.g. /skills/view/mining */
  path: string;
  defaultResource: string;
  /** Known resource labels on the skill page. */
  resources: string[];
  /** Fishing requires Cheap Bait from /merchants (General Goods, 2g). */
  requiresBait?: boolean;
}

/** Gather skills that share the global one-at-a-time CURRENT ACTION slot. */
export const GATHER_SKILL_IDS: SkillId[] = ['woodcutting', 'mining', 'fishing'];

export const SKILL_CONFIGS: Record<SkillId, SkillConfig> = {
  woodcutting: {
    id: 'woodcutting',
    path: '/skills/view/woodcutting',
    defaultResource: 'Oak Log',
    resources: ['Oak Log', 'Yew Log'],
  },
  mining: {
    id: 'mining',
    path: '/skills/view/mining',
    defaultResource: 'Coal Ore',
    resources: ['Coal Ore', 'Tin Ore', 'Limestone'],
  },
  fishing: {
    id: 'fishing',
    path: '/skills/view/fishing',
    defaultResource: 'Cod',
    resources: ['Cod', 'Salmon', 'Tuna'],
    requiresBait: true,
  },
};

export function getSkillConfig(skill: string): SkillConfig {
  const normalized = skill.toLowerCase() as SkillId;
  const config = SKILL_CONFIGS[normalized];
  if (!config) {
    const valid = Object.keys(SKILL_CONFIGS).join(', ');
    throw new Error(`Unknown skill "${skill}". Valid skills: ${valid}`);
  }
  return config;
}

export function resolveResource(config: SkillConfig, resource?: string): string {
  if (!resource) return config.defaultResource;
  const match = config.resources.find((r) => r.toLowerCase() === resource.toLowerCase());
  if (!match) {
    throw new Error(
      `Unknown resource "${resource}" for ${config.id}. Valid: ${config.resources.join(', ')}`,
    );
  }
  return match;
}
