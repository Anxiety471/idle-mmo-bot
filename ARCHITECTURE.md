# Architecture

## Overview

```
┌─────────────┐     decisions      ┌──────────────┐
│   cli.ts    │ ◄────────────────► │  JevAdvisor  │
│  (commands) │                    │ stub/console │
└──────┬──────┘                    └──────────────┘
       │ clicks / reads
       ▼
┌─────────────────────┐
│  src/deterministic/ │
│  gather combat quest│
└──────────┬──────────┘
           │ Playwright
           ▼
    web.idle-mmo.com
```

**Deterministic** modules know *how* to drive the UI. **Jev** decides *what* to do at branching points. This split keeps automation testable without an LLM and lets a real agent swap in via one interface.

## Layers

### `src/config.ts`

Loads `BASE_URL`, `POLL_MS`, `HEADLESS`, `STORAGE_STATE` from environment (via dotenv).

### `src/browser.ts`

Launches Chromium, optionally loads `storageState` for session cookies, provides `navigateTo` helper.

### `src/types.ts`

Shared state snapshots passed to Jev: `GatherState`, `HuntState`, `BattleState`, `QuestState`, result enums.

### `src/deterministic/`

| Module | Route | Flow |
|--------|-------|------|
| `gather.ts` | `/skills/view/woodcutting` | Detect `CURRENT ACTION` → busy; else select Oak Log → Start; handle replace dialog |
| `combat.ts` | `/combat/battle` | Start Hunt → wait enemies → Stop → pick card → max/stance → Battle → Hunt More / Run Away |
| `quest.ts` | `/quests` | Open card → Talk → dialogue → Overview progress → Turn In when enabled |

Comments in each file note that UI selectors are live-tested but may drift.

### `src/jev/`

#### `JevAdvisor` interface

| Method | When called | Typical StubJev behavior |
|--------|-------------|--------------------------|
| `shouldInterruptGather(state)` | Before gather restart if another action may be running | `false` — never interrupt |
| `decideHuntStop(state)` | During hunt polling | `true` after 1 defeated enemy |
| `chooseStance(enemy)` | Before Battle click | `Balanced` |
| `chooseMaxEnemies(enemy)` | Before Battle click | `1` |
| `shouldFlee(battleState)` | Each poll during battle | `true` only if HP &lt; 25% detectable |
| `pickQuestPriority(quests)` | Quest command start | Prefer "Wood for the Hearth" |

#### Implementations

- **`StubJev`** — production default in CLI; conservative, no logging overhead.
- **`ConsoleJev`** — same defaults but logs every decision; enabled with `-v`.

#### Implementing a real Jev agent

1. Implement `JevAdvisor` in a new file (e.g. `src/jev/openai-jev.ts`).
2. Use `state.pageText` and parsed fields as LLM context; return structured decisions.
3. On parse failure or timeout, fall back to `StubJev` behavior.
4. Register in `cli.ts` via env var, e.g. `JEV_PROVIDER=openai`.
5. Never let Jev invent UI outcomes — only deterministic code clicks buttons.

Example decision prompt (gather):

> Page shows CURRENT ACTION: {state.currentResource}. User wants Oak Log. Interrupt? Reply JSON: `{ "interrupt": false }`

### `src/cli.ts`

Commander entry point:

| Command | Loop behavior |
|---------|---------------|
| `gather` | Poll busy/idle → `restartGather` when idle |
| `combat` | `startHunt` → wait → Jev stop → `configureAndBattle` → flee check → `huntMore` |
| `quest` | Jev priority → open → talk → turn in if enabled |
| `farm-hearth` | Accept hearth quest → gather loop until Turn In enabled |

## Replace-dialog policy

When starting gather or hunt while another action runs, the game shows **"Start a new action?"**:

- **Close** — keep current action (default for gather helper).
- **Start anyway** — replace (only when `allowInterrupt` is true from Jev).

CLI never sets `allowInterrupt` unless `jev.shouldInterruptGather()` returns true.

## Extending

- Add new deterministic flows under `src/deterministic/` with parallel Jev hooks if needed.
- Add npm script + commander subcommand in `cli.ts`.
- Keep secrets and `storage-state.json` out of the repo (see `.gitignore`).
