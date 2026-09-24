# Architecture

## Overview

```
┌─────────────┐     snapshot      ┌──────────────────┐
│  autopilot  │ ────────────────► │  GameSnapshot    │
│  supervisor │                   │  allowed actions │
└──────┬──────┘                   └────────┬─────────┘
       │ chooseNextAction                  │
       ▼                                   ▼
┌──────────────┐   one action    ┌─────────────────────┐
│ Supervisor   │ ──────────────► │ actions/executor    │
│ Advisor      │                 │ (deterministic)     │
│ ProgStubJev  │                 └──────────┬──────────┘
└──────────────┘                            │ Playwright
                                            ▼
                                     web.idle-mmo.com
```

**Deterministic** modules know *how* to drive the UI. **Jev** decides *what* to do at branching points. The **autopilot supervisor** loops: snapshot → allowed actions → Jev choice → execute one action.

An external overseer agent can supervise `npm run autopilot` logs; multi-bot party coordination is out of scope but uses the same per-account `SupervisorAdvisor` hook.

### Extending the autopilot (not hard-limited to bootstrap)

```
registerBootstrapActions()     ← starter pack at startup
registerDiscoveredAction(def)  ← add when a loop is scriptable
SNAPSHOT_ENRICHERS.push(...)   ← add snapshot fields (zones, pets, …)
discoverFeatures(page)         ← logs unregistered nav routes for overseer
```

New actions need: `id`, `description`, `isAllowed(snapshot)`, `execute(page)`, `safety` (no real-money). ProgressiveStubJev (live path) reads descriptions from the registry automatically.

## Layers

### `src/config.ts`

Loads `BASE_URL`, `POLL_MS`, `HEADLESS`, `STORAGE_STATE`, `BUY_BAIT` from environment (via dotenv).

### `src/api/`

Read-only IdleMMO Public API client (`IDLE_MMO_API_KEY`, origin default `https://api.idle-mmo.com`). Allowlisted `GET /v1/…` routes only, 20 requests/minute with a cache. Autopilot refresh overlays character information, current action, and pets. Inventory stays on the Playwright scrape. See [docs/IDLE_MMO_PUBLIC_API.md](docs/IDLE_MMO_PUBLIC_API.md).

### `src/browser.ts`

Launches Chromium, optionally loads `storageState` for session cookies, provides `navigateTo` helper.

### `src/types.ts`

Shared state snapshots passed to Jev: `GatherState`, `HuntState`, `BattleState`, `QuestState`, result enums.

### `src/deterministic/`

| Module | Route | Flow |
|--------|-------|------|
| `skills.ts` | — | Skill configs for gather/craft skills; `resourceRequired` for unconfirmed defaults |
| `gather.ts` | `/skills/view/<skill>` | Wait for UI settle; probe other skill pages for global busy; never click disabled Start; `missing_requirement` for fishing without bait |
| `combat.ts` | `/combat/battle` | `ensureHuntActive` (Start Hunt / Hunt More / already hunting / enemy-select); replace dialog; Stop → Battle → Hunt More |
| `quest.ts` | `/quests` | Tab switch → open card → Overview → Turn In when enabled; `turnInQuestWhenReady` |
| `merchant.ts` | `/merchants` | General Goods → Cheap Bait → buy 1 (only when `--buy-bait` / `BUY_BAIT`) |

Comments in each file note that UI selectors are live-tested but may drift.

### `src/jev/`

#### `JevAdvisor` interface

| Method | When called | Typical StubJev behavior |
|--------|-------------|--------------------------|
| `shouldInterruptGather(state)` | Before gather restart if another action may be running | `false` — never interrupt |
| `decideHuntStop(state)` | During hunt polling (Stop visible) | `true` when Total Enemies Found ≥ cap (default 100) |
| `chooseStance(enemy)` | Before Battle click | `Balanced` |
| `chooseMaxEnemies(enemy)` | Before Battle click | `1` |
| `shouldFlee(battleState)` | Each poll during battle | `true` only if HP &lt; 25% detectable |
| `pickQuestPriority(quests)` | Quest command start | Prefer "Wood for the Hearth" |

#### Implementations

- **`ProgressiveStubJev`** — **live autopilot path** (`createSupervisor` always); rotates gather skills, prioritizes kill quests / turn-ins / combat XP. Wrapped with `LoggingJev` (and optional `ConsoleJev` with `-v`).
- **`StubJev`** — conservative defaults for single-purpose CLI commands.
- **`HttpJev`** — **unit tests only**. TypeSafe System One client kept in-tree so playbook tests can assert deterministic skips; **not** instantiated by `createSupervisor` / `createJev` even if `JEV_API_TOKEN` is set.
- **`ConsoleJev`** — wraps any inner advisor and logs every decision; enabled with `-v`.

#### Autopilot allowed actions

| Action | Deterministic module |
|--------|---------------------|
| `continue_current` | poll/backoff |
| `gather_oak` / `gather_yew` | `gather.ts` woodcutting |
| `mine_coal` | `gather.ts` mining |
| `fish_cod` | `gather.ts` fishing |
| `buy_bait` | `merchant.ts` |
| `hunt_battle` | `combat.ts` one hunt→battle round |
| `quest_talk_accept` | `quest.ts` pending tab |
| `quest_turnin` | `quest.ts` turn-in when enabled |
| `craft_if_ready` | `craft.ts` smelt coal (minimal) |
| `sell_junk` | `inventory.ts` Sell to Vendor (configured list) |
| `idle` | backoff on unknown UI |

#### Live path factory

`createSupervisor` / `createJev` in `src/jev/create-jev.ts` **always** return `LoggingJev(ProgressiveStubJev)` (optionally wrapped in `ConsoleJev`). TypeSafe/HttpJev is removed from the live bot path — do not document or set `JEV_API_TOKEN` for autopilot.

### `src/cli.ts`

| Command | Behavior |
|---------|----------|
| `gather` | Woodcutting Oak Log alias |
| `skill` | `--skill` + `--resource`; `--buy-bait` for fishing |
| `mine` / `fish` | npm aliases |
| `quest-turnin` | Accepted tab → open quest → Turn In when enabled |
| `quest` | Jev priority → talk → turn in if enabled |
| `farm-hearth` | Gather until hearth quest turn-in |
| `combat` | Hunt loop; `--interrupt` / `FORCE_INTERRUPT` for replace dialog; backs off when blocked |
| `autopilot` | Forever loop: quest → combat → gather → sell junk; session relaunch on crash |

## Replace-dialog policy

When starting gather or hunt while another action runs, the game shows **"Start a new action?"**:

- **Close** — keep current action (default).
- **Start anyway** — replace (only when `allowInterrupt` is true from Jev).

Gather and combat both back off instead of hammering Start/Hunt every poll when blocked.

## Merchant purchases

Off by default. Fishing with `--buy-bait` or `BUY_BAIT=true` buys one Cheap Bait at `/merchants` → General Goods when `missing_requirement` is detected.

## Extending

- Add skill configs in `skills.ts`; use `resourceRequired` until playbook confirms item labels.
- Add npm script + commander subcommand in `cli.ts`.
- Keep secrets and `storage-state.json` out of the repo (see `.gitignore`).
