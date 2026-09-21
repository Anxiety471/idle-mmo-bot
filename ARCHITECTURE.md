# Architecture

## Overview

```
┌─────────────┐     decisions      ┌──────────────┐
│   cli.ts    │ ◄────────────────► │  JevAdvisor  │
│  (commands) │                    │ stub/console │
└──────┬──────┘                    └──────────────┘
       │ clicks / reads
       ▼
┌─────────────────────────────────────┐
│  src/deterministic/                 │
│  gather · combat · quest · merchant │
└──────────┬──────────────────────────┘
           │ Playwright
           ▼
    web.idle-mmo.com
```

**Deterministic** modules know *how* to drive the UI. **Jev** decides *what* to do at branching points. This split keeps automation testable without an LLM and lets a real agent swap in via one interface.

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
| `decideHuntStop(state)` | During hunt polling | `true` after 1 defeated enemy |
| `chooseStance(enemy)` | Before Battle click | `Balanced` |
| `chooseMaxEnemies(enemy)` | Before Battle click | `1` |
| `shouldFlee(battleState)` | Each poll during battle | `true` only if HP &lt; 25% detectable |
| `pickQuestPriority(quests)` | Quest command start | Prefer "Wood for the Hearth" |

#### Implementations

- **`StubJev`** — production default in CLI; conservative, no logging overhead.
- **`ConsoleJev`** — same defaults but logs every decision; enabled with `-v`.

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
