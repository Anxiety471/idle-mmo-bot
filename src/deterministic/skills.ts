/**
 * Skill gather/craft configuration derived from live-tested UI (Sep 2025).
 * Routes: /skills/view/<skill> (note: /skills alone 404s).
 */

export type SkillId =
  | 'woodcutting'
  | 'mining'
  | 'fishing'
  | 'alchemy'
  | 'smelting'
  | 'cooking'
  | 'forge'
  | 'construction';

export interface SkillConfig {
  id: SkillId;
  /** Path segment after BASE_URL, e.g. /skills/view/mining */
  path: string;
  /** Default resource label; empty when not confirmed in playbook. */
  defaultResource: string;
  /** Known resource labels on the skill page (may be empty until confirmed). */
  resources: string[];
  /** When true, CLI must pass --resource (no confirmed default). */
  resourceRequired?: boolean;
  /** Fishing requires Cheap Bait from /merchants (General Goods, 2g). */
  requiresBait?: boolean;
}

/** Skills that share the global one-at-a-time CURRENT ACTION slot. */
export const GATHER_SKILL_IDS: SkillId[] = [
  'woodcutting',
  'mining',
  'fishing',
  'alchemy',
  'smelting',
  'cooking',
  'forge',
  'construction',
];

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
  alchemy: {
    id: 'alchemy',
    path: '/skills/view/alchemy',
    defaultResource: '',
    resources: [],
    resourceRequired: true,
  },
  smelting: {
    id: 'smelting',
    path: '/skills/view/smelting',
    defaultResource: '',
    resources: [],
    resourceRequired: true,
  },
  cooking: {
    id: 'cooking',
    path: '/skills/view/cooking',
    defaultResource: 'Cooked Cod',
    resources: ['Cooked Cod', 'Cooked Salmon', 'Cooked Tuna'],
    resourceRequired: true,
  },
  forge: {
    id: 'forge',
    path: '/skills/view/forge',
    defaultResource: '',
    resources: [],
    resourceRequired: true,
  },
  construction: {
    id: 'construction',
    path: '/skills/view/construction',
    defaultResource: '',
    resources: [],
    resourceRequired: true,
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
  if (config.resourceRequired && !resource) {
    throw new Error(
      `--resource is required for ${config.id} (item labels not yet confirmed in playbook)`,
    );
  }

  if (resource) {
    if (config.resources.length > 0) {
      const match = config.resources.find((r) => r.toLowerCase() === resource.toLowerCase());
      if (!match) {
        throw new Error(
          `Unknown resource "${resource}" for ${config.id}. Valid: ${config.resources.join(', ')}`,
        );
      }
      return match;
    }
    return resource;
  }

  if (!config.defaultResource) {
    throw new Error(`--resource is required for ${config.id}`);
  }

  return config.defaultResource;
}
