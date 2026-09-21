import { loadConfig } from './config.js';
import { launchBrowser } from './browser.js';
import { executeAction } from './actions/executor.js';
import { createSupervisor } from './jev/create-jev.js';
import { deriveAllowedActions, parseJunkSellItems } from './snapshot/allowed-actions.js';
import { readGameSnapshot } from './snapshot/read-snapshot.js';
import type { AutopilotAction, AutopilotContext } from './types.js';

export interface RunAutopilotOptions {
  verbose?: boolean;
  forceInterrupt?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGatherAction(action: AutopilotAction): boolean {
  return action.startsWith('gather_') || action === 'mine_coal' || action === 'fish_cod';
}

/**
 * Progressive supervisor autopilot:
 * snapshot → allowed actions → Jev choice → execute one action → repeat forever.
 */
export async function runAutopilot(options: RunAutopilotOptions = {}): Promise<void> {
  const config = loadConfig();
  const supervisor = createSupervisor(options.verbose ?? false);
  const junkItems = parseJunkSellItems();
  const hasJevToken = Boolean(
    process.env.JEV_API_TOKEN?.trim() || process.env.TYPESAFE_API_KEY?.trim(),
  );

  console.log('[autopilot] Progressive supervisor loop starting (SIGINT to stop)');
  console.log(
    `[autopilot] Jev: ${hasJevToken ? 'HttpJev (TypeSafe API)' : 'ProgressiveStubJev (no token)'}`,
  );
  console.log('[autopilot] Flow: snapshot → allowed actions → Jev → execute one action');

  const context: AutopilotContext = {
    cycle: 0,
    gatherRotationIndex: 0,
  };

  const sessionRelaunchMs = Math.max(config.pollMs * 6, 30_000);

  while (true) {
    const session = await launchBrowser(config);
    try {
      while (true) {
        context.cycle++;

        let snapshot;
        try {
          snapshot = await readGameSnapshot(session.page, config);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[autopilot] snapshot failed: ${message}`);
          await sleep(sessionRelaunchMs);
          break;
        }

        const allowed = deriveAllowedActions(snapshot, config, junkItems);
        const action = await supervisor.chooseNextAction(snapshot, allowed, context);
        context.lastAction = action;

        if (isGatherAction(action)) {
          context.gatherRotationIndex += 1;
        }

        console.log(
          `[autopilot] cycle=${context.cycle} location=${snapshot.location}` +
            ` gold=${snapshot.gold ?? '?'} combat=${snapshot.combatLevel ?? '?'}` +
            ` busy=${snapshot.currentAction?.busy ?? false}`,
        );
        console.log(`[autopilot] allowed=[${allowed.join(', ')}] → ${action}`);

        let result;
        try {
          result = await executeAction(action, session.page, config, supervisor, {
            forceInterrupt: options.forceInterrupt,
            junkItems,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[autopilot] execute ${action} error: ${message}`);
          result = { action, outcome: 'error', backoffMs: config.pollMs * 2 };
        }

        console.log(`[autopilot] result: ${result.outcome}`);
        await sleep(result.backoffMs ?? config.pollMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[autopilot] session error — relaunching in ${sessionRelaunchMs / 1000}s: ${message}`,
      );
      await sleep(sessionRelaunchMs);
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}

// Re-export for CLI compatibility
export type AutopilotOptions = RunAutopilotOptions;
