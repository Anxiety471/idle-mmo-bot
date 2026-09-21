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
│ Http/ProgStub│                 └──────────┬──────────┘
└──────────────┘                            │ Playwright
                                            ▼
                                     web.idle-mmo.com
```

**Deterministic** modules know *how* to drive the UI. **Jev** decides *what* to do at branching points. The **autopilot supervisor** loops: snapshot → allowed actions → Jev choice → execute one action.

An external overseer agent can supervise `npm run autopilot` logs; multi-bot party coordination is out of scope but uses the same per-account `SupervisorAdvisor` hook.

## Layers

### `src/config.ts`

Loads `BASE_URL`, `POLL_MS`, `HEADLESS`, `STORAGE_STATE`, `BUY_BAIT` from environment (via dotenv).

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
| `decideHuntStop(state)` | During hunt polling (Stop visible) | `true` when Total Enemies Found ≥ 1 |
| `chooseStance(enemy)` | Before Battle click | `Balanced` |
| `chooseMaxEnemies(enemy)` | Before Battle click | `1` |
| `shouldFlee(battleState)` | Each poll during battle | `true` only if HP &lt; 25% detectable |
| `pickQuestPriority(quests)` | Quest command start | Prefer "Wood for the Hearth" |

#### Implementations

- **`StubJev`** — CLI default when no API token is set; conservative, no network calls.
- **`HttpJev`** — real advisor via TypeSafe System One API (`POST /v1/systemone`). Enabled when `JEV_API_TOKEN` or `TYPESAFE_API_KEY` is set. On API error, falls back to StubJev and logs.
- **`ConsoleJev`** — wraps any inner advisor and logs every decision; enabled with `-v`.

#### TypeSafe API mapping (`HttpJev`)

Each `JevAdvisor` method sends one System One request with structured JSON state (from `GatherState`, `HuntState`, `BattleState`, `EnemyInfo`, or `QuestInfo` — no `pageText`, no screenshots).

| Method | State payload | Question key | Type | Result |
|--------|---------------|--------------|------|--------|
| `shouldInterruptGather` | `{ context, busy, busyElsewhere, skill, ... }` | `interrupt` | noul | `noul >= JEV_NOUL_THRESHOLD` |
| `decideHuntStop` | hunt metrics + enemies | `stop` | noul | `noul >= threshold` |
| `chooseStance` | `{ enemy }` | `stance` | choice | winning stance label |
| `chooseMaxEnemies` | `{ enemy }` | `maxEnemies` | score | `round(score) + 1`, clamped 1–5 |
| `shouldFlee` | `{ inBattle, playerHpPercent, ... }` | `flee` | noul | `noul >= threshold` |
| `pickQuestPriority` | quest list | `priority` | choice | chosen title first; `keep_gathering` → `[]` |

Config (`src/jev/jev-config.ts`): `JEV_API_TOKEN` / `TYPESAFE_API_KEY`, `JEV_MODEL` (default `jev-latest`), `JEV_NOUL_THRESHOLD` (default `0.6`).

Smoke test: `npm run jev-smoke` (`src/jev-smoke.ts`).

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
