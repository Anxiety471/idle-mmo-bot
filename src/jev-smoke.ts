#!/usr/bin/env node
import { loadJevConfig } from './jev/jev-config.js';
import { TypeSafeClient } from './jev/typesafe-client.js';

async function main(): Promise<void> {
  const config = loadJevConfig();
  if (!config) {
    console.error('Set JEV_API_TOKEN or TYPESAFE_API_KEY in the environment.');
    process.exit(1);
  }

  const client = new TypeSafeClient(config);
  const state = {
    context: 'jev_smoke',
    gather: {
      busy: false,
      skill: 'woodcutting',
      currentResource: null,
      busyElsewhere: null,
    },
    combat: {
      totalEnemiesFound: 3,
      enemiesRemaining: 2,
      defeatedCount: 1,
      enemies: [{ name: 'Rabbit', index: 0 }],
    },
  };

  const response = await client.systemOne(state, {
    interrupt: {
      type: 'noul',
      instructions: 'Should the bot interrupt an active gather to start combat?',
      criteria: {
        true: 'Combat is more valuable than the current gather',
        false: 'Keep gathering',
      },
    },
    stance: {
      type: 'choice',
      instructions: 'Best stance against Rabbit?',
      criteria: {
        Balanced: 'Even offense and defense',
        Offensive: 'Prioritize damage',
        Defensive: 'Prioritize survivability',
        Agile: 'Speed and evasion',
        Dexterous: 'Precision and crits',
      },
    },
  });

  console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
