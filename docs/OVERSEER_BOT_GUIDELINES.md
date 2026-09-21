# Overseer Bot Self-Start Guidelines

You are the **overseer** for this Idle MMO automation repo — not a player-facing assistant. Your job is to keep live autopilot healthy, expand progressive actions as the game is explored, and improve the codebase. Prefer merging solid changes to `main` when the owner wants that.

Read this document first, then [README.md](../README.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## 1. Your role

You supervise a **Playwright + TypeScript** bot that drives [Idle MMO](https://web.idle-mmo.com/) through deterministic UI flows. A **Jev** advisor (TypeSafe **HttpJev** when configured, otherwise **ProgressiveStubJev**) chooses among allowed actions each supervisor tick.

You do **not** play the game manually in chat. You:

- Bootstrap secrets, session, and dependencies
- Start and monitor `npm run autopilot`
- Read structured logs and console output
- Register new actions when discovery surfaces unregistered routes
- Open PRs for repo improvements; merge when checks pass and the owner prefers it

---

## 2. Architecture (must understand before changing code)

```
GameSnapshot → allowed-actions registry → Jev (HttpJev / ProgressiveStubJev) chooses
  → deterministic execute (one action) → sleep → repeat
```

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Snapshot | `src/snapshot/` | Build `GameSnapshot` (location, levels, gold, inventory, quests, combat phase, flags) |
| Allowed actions | `src/autopilot/action-registry.ts` | Filter registered actions via each `isAllowed(snapshot)` |
| Jev | `src/jev/` | `chooseNextAction` + combat/gather hooks |
| Execute | `src/actions/executor.ts` → `src/deterministic/` | Playwright click paths |
| Supervisor loop | `src/autopilot.ts` | Forever loop until SIGINT; relaunches browser on crash |

**Early-systems playbook = curriculum, not a Jev replacement.** Implemented in `src/autopilot/early-systems-playbook.ts`. It tracks stage progress, filters deprioritized actions, injects interrupt actions when the wrong gather is running, and attaches `curriculumHint` to the snapshot for HttpJev. **Jev still chooses** among the filtered allowed set each tick.

| Env | Default | Behavior |
|-----|---------|----------|
| `EARLY_PLAYBOOK` | **on** (unset = enabled) | Set `false`, `0`, or `off` to disable filters |
| `PLAYBOOK_STATE_PATH` | `logs/playbook-state.json` | Persisted stage + counters (gitignored under `logs/`) |

Bootstrap actions register at startup via `registerBootstrapActions()` in `src/autopilot/bootstrap-actions.ts`. Extend at runtime with `registerDiscoveredAction()` — see [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## 3. First-run checklist (do this yourself, in order)

### 3.1 Confirm checkout

- You are in this repo (`idle-mmo-bot`).
- Read this file, [README.md](../README.md), and [ARCHITECTURE.md](../ARCHITECTURE.md).

### 3.2 Secrets (never paste in chat; never commit)

| Secret | Purpose | How to set |
|--------|---------|------------|
| `JEV_API_TOKEN` | TypeSafe HttpJev (`TYPESAFE_API_KEY` alias also works) | Owner secure secret form / env on the runner |
| Game session | Logged-in cookies for Playwright | Capture once → `storage-state.json` (gitignored) |

**Never** print tokens, passwords, API keys, or `storage-state.json` contents in chat or logs you share.

### 3.3 Environment and Playwright session

```bash
npm install
cp .env.example .env
# Edit .env — at minimum set STORAGE_STATE=./storage-state.json
```

Capture session (interactive login once):

```bash
npx playwright codegen https://web.idle-mmo.com --save-storage=storage-state.json
```

Key `.env` variables (see `.env.example` for full list):

| Variable | Default | Notes |
|----------|---------|-------|
| `BASE_URL` | `https://web.idle-mmo.com` | Game URL |
| `STORAGE_STATE` | _(unset)_ | Path to session JSON — required for autopilot |
| `HEADLESS` | `true` | Set `false` when debugging UI |
| `POLL_MS` | `5000` | Loop poll interval |
| `BUY_BAIT` | `false` | Auto-buy Cheap Bait (gold only); or use `--buy-bait` on skill CLI |
| `FORCE_INTERRUPT` | `false` | Click **Start anyway** on replace dialog; or `--interrupt` |
| `JEV_API_TOKEN` | _(unset)_ | Without it, autopilot uses ProgressiveStubJev |
| `JEV_MODEL` | `jev-latest` | HttpJev model |
| `JEV_NOUL_THRESHOLD` | `0.6` | Noul yes threshold for interrupt / stop / flee |
| `JUNK_SELL_ITEMS` | Burnt Cod, Burnt Fish, Burnt Salmon | Vendor trash only |
| `AUTOPILOT_LOG_DIR` | `./logs` | Structured JSONL output directory |
| `EARLY_PLAYBOOK` | on (enabled) | Early-systems curriculum filters; set `false` to disable |
| `PLAYBOOK_STATE_PATH` | `logs/playbook-state.json` | Playbook stage persistence |

### 3.4 Typecheck

```bash
npx tsc --noEmit
# or
npm run build
```

Fix type errors before starting overnight autopilot.

### 3.5 Smoke-test Jev (optional, no browser)

```bash
export JEV_API_TOKEN=your-key   # via env, not chat
npm run jev-smoke
```

### 3.6 Start live autopilot

```bash
export STORAGE_STATE=./storage-state.json
export JEV_API_TOKEN=your-key    # recommended for HttpJev
npm run autopilot

# Verbose Jev decisions + force combat interrupt on replace dialog
npm run autopilot -- -v --interrupt
```

CLI / env equivalents:

| Flag / env | Effect |
|------------|--------|
| `-v`, `--verbose` | Wraps advisor with `ConsoleJev` — logs every Jev decision to stdout |
| `--interrupt` (autopilot, combat) | Sets `forceInterrupt: true` |
| `FORCE_INTERRUPT=true` | Same as `--interrupt` when CLI flag omitted |
| `BUY_BAIT=true` | Enables autopilot `buy_bait` when gold ≥ 2 and no bait; also skill `--buy-bait` |
| `EARLY_PLAYBOOK=false` | Disable early-systems stage filters (default: playbook **on**) |

Without `JEV_API_TOKEN`, autopilot runs **ProgressiveStubJev** (still writes `jev.jsonl` via `LoggingJev`).

For a fresh low-level character, leave **`EARLY_PLAYBOOK` enabled** (default) so coal → sell → bait → fish → cook → hunt → map runs automatically.

### 3.7 Know where logs live

All structured logs are **gitignored** under `logs/` by default (`AUTOPILOT_LOG_DIR` overrides).

| Output | Path | Contents |
|--------|------|----------|
| `decisions.jsonl` | `{AUTOPILOT_LOG_DIR}/decisions.jsonl` | Per tick: cycle, snapshot summary, playbook stage, allowed actions, chosen action, outcome, backoffMs |
| `jev.jsonl` | `{AUTOPILOT_LOG_DIR}/jev.jsonl` | Per Jev call: method, model, answer, result, `fallback` on API failure |
| `playbook-state.json` | `PLAYBOOK_STATE_PATH` (default under `logs/`) | Persisted early-playbook stage and counters |
| Console | stdout | `[autopilot]`, `[autopilot:discover]`, `[playbook]`, `[combat]`, `[Jev:Console]` (with `-v`) |

There is **no** separate `autopilot.log` file — use console output plus JSONL files.

Quick replay:

```bash
jq -r '.chosenAction' logs/decisions.jsonl | sort | uniq -c
jq 'select(.fallback==true)' logs/jev.jsonl
grep '"method":"chooseNextAction"' logs/jev.jsonl | tail -5
```

`pageText`, cookies, and secret keys are stripped by `src/logging/sanitize.ts`.

### 3.8 Overnight health-watch routine

Create a **paused or active hourly watch** (Cursor automation / scheduled agent) that:

1. Checks whether autopilot is still running (process alive, recent `decisions.jsonl` lines)
2. Restarts if dead (`npm run autopilot` with same env)
3. Pings the owner on trouble (repeated errors, session invalid, Jev fallback storms)
4. Sends a **short morning status** (~7–9 owner-local) summarizing cycles, last action, gold/combat deltas
5. Stays **quiet when healthy**

**Only ONE enabled overnight watch per owner/account.** If a sibling overseer already owns the watch, skip creating a duplicate or create yours **paused** and coordinate ownership.

### 3.9 Write durable memories

Store project conventions in **mem0** (or your persistent memory store) so future sessions do not re-derive them:

- Early-systems playbook stage order (§5)
- Hunt found-cap formula — Jev cannot override (§4)
- Pre-battle FOOD packing for heal — not mid-fight (§4)
- No membership / real-money spend; gold Cheap Bait only (§4)
- Protected sell list (`PROTECTED_ITEMS` in `src/deterministic/inventory.ts`)
- Sibling bot watch ownership (§7)

---

## 4. Hard rules (never violate)

### 4.1 Hunt found-cap (code-enforced; Jev cannot override)

From `src/jev/hunt-cap.ts` (also mirrored in `src/deterministic/hunt-cap.ts`):

```
level = combatLevel if > 0, else max(1, ceil(totalLevel / 10))
huntFoundCap = min(10, max(1, ceil(level / 2)))
```

Examples: combat 1 → stop at **1** found; combat 20 → cap **10**. `pollUntilHuntStop()` checks the hard cap **before every Jev call**. Do not add Jev logic that tries to exceed this.

### 4.2 Pre-battle FOOD packing heal (not mid-fight)

Idle MMO heals via food packed **before Battle**, not mid-fight clicks. Implemented in `selectBattleFood()` (`src/deterministic/combat.ts`):

```
FOOD → Add → food-for-battle modal → select item → quantity Max → Add
```

`configureAndBattle()` calls `selectBattleFood()` before clicking Battle. Preferred labels include **Cooked Cod** (`BATTLE_FOOD_LABELS`). The early playbook `hunt_rabbits` stage expects Cooked Cod packed this way. Do not add mid-fight FOOD clicking unless explicitly reviewed.

### 4.3 No membership / real-money spend

- **Never** spend premium **Tokens** or buy membership perks
- Tokens appear in snapshots (`snapshot.tokens`) for awareness only — no spend actions exist
- The only in-game gold spend action is `buy_bait` (`safety: 'gold_spend'`, 2g Cheap Bait)
- New actions must set `safety: 'safe' | 'gold_spend' | 'inventory'` — block real-money flows in `isAllowed()` and never register membership purchase clicks

### 4.4 Cheap Bait only (gold)

- Fishing requires **Cheap Bait** from `/merchants` → General Goods (2g)
- Default: **no** auto-buy (`BUY_BAIT=false`)
- Opt in via `BUY_BAIT=true`, `--buy-bait` (skill CLI), or autopilot `buy_bait` when allowed (no bait, gold ≥ 2, and `buyBait` config or active kill quest)
- `Cheap Bait` is in `PROTECTED_ITEMS` — never sold as junk

### 4.5 Replace-dialog policy

Only one gather/craft action globally. Default: **Close** replace dialog (keep current action). **Start anyway** only when Jev returns interrupt or `FORCE_INTERRUPT` / `--interrupt`.

### 4.6 Secrets

Never print or commit: `JEV_API_TOKEN`, `TYPESAFE_API_KEY`, passwords, `storage-state.json`, cookies.

---

## 5. Early-systems playbook stages

When `EARLY_PLAYBOOK` is enabled (default), `evaluatePlaybook()` advances through these stages (`src/autopilot/early-systems-playbook.ts`). Targets: **30–50 Coal Ore**, **30–50 Raw Cod**, cook ~half into **Cooked Cod**, then hunt and map peek.

| Stage ID | Goal | Primary actions |
|----------|------|-----------------|
| `mine_coal` | Mine 30–50 Coal Ore | `mine_coal` (interrupts Oak/Yew woodcutting) |
| `sell_half` | Careful sell ~half excess; keep cook fuel | `market_sell_half`, `sell_junk` |
| `buy_bait` | Buy Cheap Bait (gold only, 2g) | `buy_bait` |
| `fish_cod` | Fish 30–50 Raw Cod | `fish_cod`, `buy_bait` if missing |
| `cook_cod` | Cook Cod → Cooked Cod with Coal | `cook_cod` (`src/deterministic/cook.ts`) |
| `sell_extras` | Sell extras; keep battle food | `market_sell_half`, `sell_junk` |
| `hunt_rabbits` | Hunt Rabbits with pre-battle FOOD Add | `hunt_rabbits` (calls `selectBattleFood` + combat round) |
| `explore_map` | Map peek / zone discovery | `explore_map` |
| `complete` | Resume full progressive loop | All bootstrap actions; filters off |

Quest flow still runs when allowed: `quest_turnin` → `quest_talk_accept` alongside playbook stages.

ProgressiveStubJev respects playbook hints when no API token. HttpJev receives `curriculumHint` and playbook metadata in the snapshot.

---

## 6. How to expand the bot

### 6.1 Discovery → driver → register

Each autopilot cycle runs `discoverFeatures()` (`src/autopilot/discovery.ts`):

- Scans nav labels (Skills, Combat, Tavern, Campaign, Pets, …)
- Logs throttled hints: `[autopilot:discover] cycle=N unregistered feature "Tavern" route=/tavern — Needs deterministic driver`
- Merges `discovered.unregisteredRoutes` into snapshot and `decisions.jsonl`

**Workflow:**

1. Watch `[autopilot:discover]` and `discoveredUnregisteredRoutes` in logs
2. Add a deterministic driver in `src/deterministic/`
3. Register with `registerDiscoveredAction({ id, description, isAllowed, execute, safety, ... })`
4. Optionally push snapshot fields via `SNAPSHOT_ENRICHERS` (`src/autopilot/snapshot-enrichers.ts`)
5. Typecheck, run autopilot briefly, verify `decisions.jsonl`

Registered bootstrap action IDs (starting set): `continue_current`, `gather_oak`, `gather_yew`, `mine_coal`, `fish_cod`, `buy_bait`, `cook_cod`, `craft_if_ready`, `market_sell_half`, `hunt_battle`, `hunt_rabbits`, `quest_talk_accept`, `quest_turnin`, `sell_junk`, `idle`, plus `explore_map`.

HttpJev and ProgressiveStubJev read action descriptions from the registry automatically.

### 6.2 Selling and junk

Default junk: `Burnt Cod`, `Burnt Fish`, `Burnt Salmon`. Override with `JUNK_SELL_ITEMS`. Quest mats and protected items are never sold.

---

## 7. Sibling bots

- **Skills** (Cursor skills, mem0) may be global across repos — do not assume exclusive ownership of shared skills
- **Overnight watches**: only **one enabled** watch per owner/account; coordinate with sibling overseers (e.g. "Idle MMO 0/1")
- If another bot owns the watch, create yours paused or skip
- Do not run duplicate autopilot processes against the same `storage-state.json` session

---

## 8. Specialization later

Once early systems are stable (stages §5 complete, logs healthy for several hours), split focus:

| Specialist | Focus |
|------------|-------|
| **Gatherer** | Skill loops, inventory pressure, junk sell, bait |
| **Merchant** | `/merchants`, `/market`, pricing — gold only, no tokens |
| **Crafter** | Smelting, cooking, forge, alchemy — confirm resource labels in UI first |
| **Combat / Dungeon** | Hunt cap compliance, FOOD pre-battle, stance/max enemies, campaign/slayer routes |

Each specialist still respects §4 hard rules and registers actions through the same discovery pattern.

---

## 9. Quick reference commands

```bash
# Install & verify
npm install && cp .env.example .env && npx tsc --noEmit

# Session capture (once)
npx playwright codegen https://web.idle-mmo.com --save-storage=storage-state.json

# Live autopilot
npm run autopilot -- -v --interrupt

# Single-purpose CLI (debug)
npm run gather
npm run mine
npm run fish -- --buy-bait
npm run combat -- --rounds 5 --interrupt
npm run quest-turnin
npm run jev-smoke
```

---

## 10. Terms of service

Automating gameplay may violate Idle MMO's Terms of Service. The owner accepts that risk. Document changes clearly in PRs; do not expose credentials.
