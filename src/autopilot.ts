import { ensureActiveCharacter } from './character/character-select.js';
import { resolveCharacterPaths } from './character/paths.js';
import {
  nextRosterCharacter,
  parseCharacterRoster,
  rotateToRosterCharacter,
  shouldRotateWhileBusy,
} from './character/roster.js';
import { loadConfig } from './config.js';
import { launchBrowser } from './browser.js';
import {
  closeBrowserSessionWithTimeout,
  shouldProactivelyRecycleBrowser,
  shouldRelaunchBrowserAfterError,
} from './browser-session.js';
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
import {
  CycleWatchdogTimeout,
  executeWatchdogMs,
  snapshotWatchdogMs,
  withCycleWatchdog,
} from './autopilot/cycle-watchdog.js';
import {
  installConsoleProgressHook,
  markProgress,
  msSinceProgress,
  noProgressWatchdogMs,
  startLivenessMonitor,
  writeHeartbeat,
} from './autopilot/liveness.js';
import {
  actionInvalidatesInventoryCache,
  invalidateInventoryDomCache,
} from './snapshot/inventory-scrape.js';
import {
  attachPlaybookToSnapshot,
  evaluatePlaybook,
  formatPlaybookLogLine,
  notePlaybookOutcome,
} from './autopilot/early-systems-playbook.js';
import type { AutopilotAction, AutopilotContext } from './types.js';
import type { BrowserSession } from './browser.js';

export interface RunAutopilotOptions {
  verbose?: boolean;
  forceInterrupt?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGatherAction(action: AutopilotAction): boolean {
  return (
    action.startsWith('gather_') ||
    action === 'mine_coal' ||
    action === 'fish_cod' ||
    action === 'cook_cod'
  );
}

let activeSession: BrowserSession | null = null;
let shuttingDown = false;

async function shutdownFromSignal(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[autopilot] ${signal} — closing browser and exiting`);
  if (activeSession) {
    await closeBrowserSessionWithTimeout(activeSession).catch(() => undefined);
    activeSession = null;
  }
  process.exit(0);
}

process.once('SIGTERM', () => {
  void shutdownFromSignal('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdownFromSignal('SIGINT');
});

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
  const paths = resolveCharacterPaths({
    storageStatePath: config.storageStatePath,
    characterName: config.characterName,
    accountSlug: config.accountSlug,
    autopilotLogDir: process.env.AUTOPILOT_LOG_DIR?.trim(),
    playbookStatePath: process.env.PLAYBOOK_STATE_PATH?.trim(),
  });
  const supervisor = createSupervisor(options.verbose ?? false);
  const junkItems = parseJunkSellItems();

  console.log('[autopilot] Progressive supervisor loop starting (SIGINT to stop)');
  console.log(
    '[autopilot] Jev: ProgressiveStubJev (deterministic; TypeSafe/HttpJev removed from live path)',
  );
  console.log('[autopilot] Flow: snapshot → discover → allowed → Jev → execute one action');
  console.log('[autopilot] Bootstrap actions registered; discovery logs unregistered UI features');
  console.log(`[autopilot] Structured logs → ${getLogDir()}/decisions.jsonl and jev.jsonl`);
  console.log(
    `[autopilot] Account=${paths.accountSlug}` +
      (config.characterName ? ` character=${config.characterName}` : ' (legacy single-character)') +
      ` logDir=${getLogDir()}`,
  );

  const context: AutopilotContext = {
    cycle: 0,
    gatherRotationIndex: 0,
    accountSlug: paths.accountSlug,
    characterName: config.characterName,
  };

  const roster = parseCharacterRoster(config.characterName, process.env.CHARACTER_ROSTER);
  if (roster.length >= 2) {
    console.log(`[autopilot] Character roster rotation: ${roster.join(' → ')}`);
  }

  const sessionRelaunchMs = Math.max(config.pollMs * 6, 30_000);
  installConsoleProgressHook();
  const stopLiveness = startLivenessMonitor(getLogDir());
  const noProgress = { limitMs: noProgressWatchdogMs(), sinceProgress: () => msSinceProgress() };
  console.log(
    `[autopilot] watchdogs: execute cap=${Math.round(executeWatchdogMs() / 60_000)}m no-progress=${Math.round(noProgress.limitMs / 60_000)}m`,
  );

  while (!shuttingDown) {
    const session = await launchBrowser(config);
    activeSession = session;
    const sessionLaunchedAtMs = Date.now();
    let relaunchReason: string | undefined;

    try {
      const charResult = await ensureActiveCharacter(session.page, config);
      console.log(
        `[autopilot] character ensure: ${charResult.outcome}` +
          (charResult.activeCharacter ? ` (${charResult.activeCharacter})` : '') +
          (charResult.message ? ` — ${charResult.message}` : ''),
      );
      if (charResult.outcome === 'failed') {
        console.error(
          '[autopilot] character bootstrap failed — snapshots may reflect the wrong alt; check CHARACTER_NAME and roster UI',
        );
      }

      while (!shuttingDown) {
        const recycle = await shouldProactivelyRecycleBrowser({
          browser: session.browser,
          launchedAtMs: sessionLaunchedAtMs,
        });
        if (recycle.recycle) {
          relaunchReason = `proactive recycle (${recycle.reason})`;
          break;
        }

        context.cycle++;
        markProgress();
        writeHeartbeat(getLogDir(), { cycle: context.cycle });
        setLogContext({
          cycle: context.cycle,
          accountSlug: context.accountSlug,
          characterName: context.characterName,
        });

        let snapshot;
        try {
          const read = await withCycleWatchdog(
            (async () => {
              const snap = await readGameSnapshot(session.page, config);
              const disc = await discoverFeatures(session.page);
              return { snap, disc };
            })(),
            snapshotWatchdogMs(),
            `snapshot cycle=${context.cycle}`,
            () => closeBrowserSessionWithTimeout(session).then(() => undefined),
            noProgress,
          );
          snapshot = read.snap;
          const discovered = read.disc;
          snapshot = mergeDiscoveryIntoSnapshot(snapshot, discovered);
          logDiscoveries(discovered, context.cycle);
          const playbook = evaluatePlaybook(snapshot, context);
          snapshot = attachPlaybookToSnapshot(snapshot, playbook);
          console.log(`[playbook] cycle=${context.cycle} ${formatPlaybookLogLine(playbook)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[autopilot] snapshot failed: ${message}`);
          if (error instanceof CycleWatchdogTimeout || shouldRelaunchBrowserAfterError(message)) {
            relaunchReason = message;
          }
          await sleep(sessionRelaunchMs);
          break;
        }

        const allowed = deriveAllowedActions(snapshot, config, junkItems, context);
        let action = await supervisor.chooseNextAction(snapshot, allowed, context);
        context.lastAction = action;

        // When current alt is busy gathering and roster has another character, rotate
        // after pets/quest interrupts — prefer managing the next alt over spinning on continue_current.
        const rosterNow = parseCharacterRoster(config.characterName, process.env.CHARACTER_ROSTER);
        const canRotate = shouldRotateWhileBusy(rosterNow, config.characterName, {
          gatherBusy: snapshot.flags.gatherBusy,
          inBattle: snapshot.flags.inBattle,
          currentActionBusy: snapshot.currentAction?.busy,
        });
        if (
          canRotate &&
          (action === 'continue_current' || action === 'idle')
        ) {
          const nextName = nextRosterCharacter(rosterNow, config.characterName);
          if (nextName) {
            console.log(
              `[autopilot] character busy — rotating ${config.characterName ?? '?'} → ${nextName}`,
            );
            const rotated = await rotateToRosterCharacter(session.page, config, nextName);
            if (rotated.ok) {
              context.characterName = config.characterName;
              setLogContext({
                cycle: context.cycle,
                accountSlug: context.accountSlug,
                characterName: context.characterName,
              });
              console.log(
                `[autopilot] rotated to ${rotated.to} logDir=${rotated.paths?.autopilotLogDir}`,
              );
              await sleep(config.pollMs);
              continue;
            }
            console.warn(
              `[autopilot] roster rotate failed: ${rotated.message ?? 'unknown'} — staying on current`,
            );
          }
        }

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
          result = await withCycleWatchdog(
            executeAction(action, session.page, config, supervisor, {
              snapshot,
              forceInterrupt: options.forceInterrupt,
              junkItems,
              context,
            }),
            executeWatchdogMs(),
            `execute ${action} cycle=${context.cycle}`,
            () => closeBrowserSessionWithTimeout(session).then(() => undefined),
            noProgress,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[autopilot] execute ${action} error: ${message}`);
          if (error instanceof CycleWatchdogTimeout) {
            // Browser already closed by the watchdog; record the cycle, then relaunch.
            notePlaybookOutcome(action, 'watchdog_timeout');
            await logDecision(snapshot, context, allowed, action, {
              action,
              outcome: 'watchdog_timeout',
            }).catch(() => undefined);
            relaunchReason = message;
            break;
          }
          if (shouldRelaunchBrowserAfterError(message)) {
            relaunchReason = message;
            break;
          }
          result = { action, outcome: 'error', backoffMs: config.pollMs * 2 };
        }

        console.log(`[autopilot] result: ${result.outcome}`);
        if (actionInvalidatesInventoryCache(action, result.outcome)) {
          invalidateInventoryDomCache();
        }
        notePlaybookOutcome(action, result.outcome);
        try {
          await logDecision(snapshot, context, allowed, action, result);
        } catch (logError) {
          const message = logError instanceof Error ? logError.message : String(logError);
          console.error(`[autopilot] decision log write failed: ${message}`);
        }
        if ((result.backoffMs ?? 0) >= 60_000) {
          // Round 9: during a long backoff park the tab on about:blank so the game page
          // (Livewire polling, client telemetry retries) sends nothing until the next cycle.
          console.log(`[autopilot] backoff ${Math.round((result.backoffMs ?? 0) / 1000)}s — parking tab on about:blank`);
          await session.page.goto('about:blank').catch(() => undefined);
        }
        await sleep(result.backoffMs ?? config.pollMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[autopilot] session error — relaunching in ${sessionRelaunchMs / 1000}s: ${message}`,
      );
      if (shouldRelaunchBrowserAfterError(message)) {
        relaunchReason = message;
      }
      await sleep(sessionRelaunchMs);
    } finally {
      await closeBrowserSessionWithTimeout(session).catch(() => undefined);
      if (activeSession === session) activeSession = null;
      if (relaunchReason) {
        console.log(`[autopilot] relaunching browser after: ${relaunchReason}`);
      }
    }
  }
  stopLiveness();
}

export type AutopilotOptions = RunAutopilotOptions;
