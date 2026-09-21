import { loadConfig } from './config.js';
import { launchBrowser } from './browser.js';
import { executeAction } from './actions/executor.js';
import { registerBootstrapActions } from './autopilot/bootstrap-actions.js';
import { deriveAllowedActions } from './autopilot/action-registry.js';
import { discoverFeatures, logDiscoveries, mergeDiscoveryIntoSnapshot } from './autopilot/discovery.js';
import { createSupervisor } from './jev/create-jev.js';
import { parseJunkSellItems } from './snapshot/allowed-actions.js';
import { logDecision } from './logging/decision-log.js';
import { getLogDir } from './logging/jsonl-writer.js';
import { setLogContext } from './logging/log-context.js';
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

// Register bootstrap actions once; discovered actions register via registerDiscoveredAction().
registerBootstrapActions();

/**
 * Progressive supervisor autopilot:
 * snapshot → discovery → allowed actions → Jev choice → execute one action → repeat forever.
 *
 * The bootstrap action list is a starting set — extend via registerDiscoveredAction() as new
 * scriptable loops are found (zones, tavern, campaign, pets, skills, etc.).
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
  console.log('[autopilot] Flow: snapshot → discover → allowed → Jev → execute one action');
  console.log('[autopilot] Bootstrap actions registered; discovery logs unregistered UI features');
  console.log(`[autopilot] Structured logs → ${getLogDir()}/decisions.jsonl and jev.jsonl`);

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
        setLogContext({ cycle: context.cycle });

        let snapshot;
        try {
          snapshot = await readGameSnapshot(session.page, config);
          const discovered = await discoverFeatures(session.page);
          snapshot = mergeDiscoveryIntoSnapshot(snapshot, discovered);
          logDiscoveries(discovered, context.cycle);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[autopilot] snapshot failed: ${message}`);
          await sleep(sessionRelaunchMs);
          break;
        }

        const allowed = deriveAllowedActions(snapshot, config, junkItems, context);
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
        if (snapshot.discovered?.unregisteredRoutes?.length) {
          console.log(
            `[autopilot] unregistered routes: ${snapshot.discovered.unregisteredRoutes.join(', ')}`,
          );
        }
        console.log(`[autopilot] allowed=[${allowed.join(', ')}] → ${action}`);

        let result;
        try {
          result = await executeAction(action, session.page, config, supervisor, {
            snapshot,
            forceInterrupt: options.forceInterrupt,
            junkItems,
            context,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[autopilot] execute ${action} error: ${message}`);
          result = { action, outcome: 'error', backoffMs: config.pollMs * 2 };
        }

        console.log(`[autopilot] result: ${result.outcome}`);

        try {
          await logDecision(snapshot, context, allowed, action, result);
        } catch (logError) {
          const message = logError instanceof Error ? logError.message : String(logError);
          console.error(`[autopilot] decision log write failed: ${message}`);
        }

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

export type AutopilotOptions = RunAutopilotOptions;
