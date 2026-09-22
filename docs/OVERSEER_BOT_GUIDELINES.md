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
| `CHARACTER_NAME` | _(unset)_ | In-game character for this process; auto-derives log/playbook paths when set |
| `ACCOUNT_SLUG` | from `STORAGE_STATE` | Override account folder (`storage-state.json` → `idlebocchi`) |
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

See [docs/CHARACTER_MANAGEMENT.md](./CHARACTER_MANAGEMENT.md) for multi-account + multi-character path layout and bootstrap env knobs (`SKIP_CHARACTER_ENSURE`, `CREATE_CHARACTER_IF_MISSING`, etc.).

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

For a fresh low-level character, leave **`EARLY_PLAYBOOK` enabled** (default) so the batch leveling loop (coal → fish → cook → hunt → repeat; pets async) runs automatically.

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

**Only ONE enabled overnight watch per owner/account.** If a sibling overseer already owns the watch, skip creating a duplicate or create yours **paused** and coordinate ownership via agent-to-agent messages (§7).

### 3.9 Write durable memories

Store project conventions in **mem0** (or your persistent memory store) so future sessions do not re-derive them:

- Early-systems playbook stage order (§5)
- Hunt found-cap formula — Jev cannot override (§4)
- Pre-battle FOOD packing for heal — not mid-fight (§4)
- No membership / real-money spend; gold Cheap Bait only (§4)
- Protected sell list (`PROTECTED_ITEMS` in `src/deterministic/inventory.ts`)
- Sibling overseer coordination + agent-to-agent notifications (§7)
- Bait trust / gather grace / gather reliability / inventory scrape hard rules (§4.7–§4.10)

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
- **Sticky bait trust:** once purchased or stage is `fish_cod+`, playbook treats bait as owned even when inventory scrape is empty — see §4.7

### 4.5 Replace-dialog policy

Only one gather/craft action globally. Default: **Close** replace dialog (keep current action). **Start anyway** only when Jev returns interrupt or `FORCE_INTERRUPT` / `--interrupt`.

### 4.6 Secrets

Never print or commit: `JEV_API_TOKEN`, `TYPESAFE_API_KEY`, passwords, `storage-state.json`, cookies.

### 4.7 Bait trust (PR #16 — stop gold-drain `buy_bait` loops)

Inventory scrape often returns **empty or icon-only** for Cheap Bait even when bait is present. Without sticky trust, autopilot can choose `buy_bait` every ~20s during `fish_cod`, draining gold.

**Rules (implemented in `early-systems-playbook.ts` + `bootstrap-actions.ts`):**

| Signal | Meaning |
|--------|---------|
| `baitOwned` | Persisted in `playbook-state.json` after a successful merchant purchase |
| `trustHasBait()` | `snapshot.flags.hasBait`, inventory count, **`baitOwned`**, or stage past `buy_bait` |
| Allowed actions | **Strip `buy_bait`** from allowed once bait is trusted or stage is **`fish_cod+`** |
| Purchase size | Buy **×20** when bait is truly missing (not ×1 repurchase loops) |
| Interrupt priority | Prefer **`fish_cod`** over repurchase when stage is `fish_cod` and bait is trusted |

**What overseers should watch:** `decisions.jsonl` showing repeated `→ buy_bait` while `stage=fish_cod` and gold dropping — fix trust/playbook gating, not more merchant clicks. After a successful buy, confirm `baitOwned=true` in playbook state and that `allowed` no longer includes `buy_bait`.

### 4.8 Fishing stickiness / gather grace (PR #17 — stop `fish_cod` restart loops)

After `fish_cod` returns `restarted`, snapshots can still show `gatherBusy=false` for several seconds before **CURRENT ACTION** appears on the fishing page. Without grace, the playbook re-injects `fish_cod` every tick and `codBusyCycles` never climbs.

**Rules (implemented in `early-systems-playbook.ts`, `gather.ts`, `bootstrap-actions.ts`):**

| Mechanism | Behavior |
|-----------|----------|
| **Wait for CURRENT ACTION** | `restartSkillGather` must see CURRENT ACTION before returning `restarted` (not a ~500ms fire-and-forget click) |
| **~30s gather grace** | After `fish_cod` + `restarted`/`already_busy`, persist `lastGatherRestartAt` / skill / resource |
| **`gatherGraceActive`** | Exposed on playbook progress; also applies to `mine_coal` restarts |
| **`continue_current` during grace** | Allowed so the bot **polls** instead of re-clicking Cod |
| **No re-injection** | `filterAllowedByPlaybook` **skips `fish_cod`** while grace is active |
| **`codBusyCycles` credit** | Increment during grace so stage progression works despite probe gaps |
| **Stub preference** | ProgressiveStubJev prefers `continue_current` during grace |
| **Backoff** | `backoffMs: pollMs * 2` after gather restart so UI can settle |

**What overseers should watch:** endless `→ fish_cod` with `result: restarted` every cycle and flat `codBusyCycles` — grace or CURRENT ACTION wait is broken. Healthy pattern: `fish_cod` → `restarted` → `continue_current` with `busy=true` and climbing `codBusyCycles`.

### 4.9 Gather reliability (PR #18 — make restarts actually stick)

Even with PR #17 grace, restarts fail when quantity is too short, the wrong Start button is clicked, overlays block clicks, or a human captcha appears after Start.

**Rules (implemented in `src/deterministic/gather.ts`):**

| Helper | Purpose |
|--------|---------|
| `dismissBlockingOverlays` | Clear modals **before** resource select (Escape **after** select can collapse the Cod panel) |
| `setGatherQuantityBatch` / Max | Default batch **8**; use **Max** when ≥20 actions available — Cod default qty=**1** (~6s) is too short vs the ~30s grace window |
| `clickStartButton` | Pick the **largest visible enabled Start**, not `.first()` (tiny hidden submits steal clicks) |
| `solveHumanCaptchaIfPresent` | **Verify** → emoji challenge when UI shows “make sure you're human”; retry Start when API returns `is_captcha` |

**Restart sequence:** dismiss overlays → select resource → set quantity → click largest Start → wait for CURRENT ACTION (5s) → on captcha: solve, re-batch, re-click Start, wait again → return **`failed`** if CURRENT ACTION never appears (preserves grace semantics).

**What overseers should watch:** `fish_cod` → `failed` or immediate idle after `restarted`; check overlays, quantity field, captcha prompts, and whether Start was disabled (missing bait — see §4.7).

### 4.11 fish_cod failure backoff (PR #24 — stop hammering failed starts)

When `fish_cod` returns `failed` or `fishing_start_failed` every tick (bait trusted, stage `fish_cod`), the bot used to re-inject `fish_cod` indefinitely. Gather grace (§4.8) only applies after `restarted`/`already_busy`, not after hard `failed`.

**Rules (implemented in `early-systems-playbook.ts`, `gather.ts`, `bootstrap-actions.ts`):**

| Mechanism | Behavior |
|-----------|----------|
| **Trusted-bait remap** | `failed` and `missing_requirement` → `fishing_start_failed` when `baitOwned`/`hasBait`/stage `fish_cod` — **never clears `baitOwned`** |
| **Failure counter** | `consecutiveFishCodFailures` increments on `failed`/`fishing_start_failed`; resets on `restarted`/`already_busy` |
| **Backoff threshold** | After **4** consecutive failures, enter **3 min** backoff (`fishCodBackoffUntil`) |
| **Fallback actions** | During backoff: prefer `continue_current`, `cook_cod`, `mine_coal`, `sell_junk_for_gold`, `idle` — **no `fish_cod` re-injection** |
| **Stage unchanged** | Stage stays `fish_cod`; backoff expires and retries resume automatically |
| **Gather retry** | `restartSkillGather` re-navigates to fishing, waits for resource panel, retries start once on fishing |

**What overseers should watch:** endless `→ fish_cod` with `result: failed` and flat `codBusyCycles` — confirm backoff kicks in (`fishCodBackoffActive=true` in decisions/playbook state) and fallbacks run. After cooldown, one `fish_cod` retry is normal. If failures persist, check §4.9 (overlays, captcha, wrong Start).

**Restarting stuck bots:** stop autopilot, verify per-character paths (§7.2), then:

```bash
# IdleBocchi example — adjust paths per character
export STORAGE_STATE=./storage-state-idlebocchi.json
export AUTOPILOT_LOG_DIR=./logs/idlebocchi
export PLAYBOOK_STATE_PATH=./logs/idlebocchi/playbook-state.json
npm run autopilot -- -v --interrupt
```

Do **not** delete `playbook-state.json` unless resetting the whole early run — `baitOwned` and stage counters live there.

### 4.10 Inventory scrape reliability (`src/snapshot/inventory-scrape.ts`)

The live `/inventory` UI is mostly **icon + quantity badge** with item names in tooltips or click-through detail panels. `readGameSnapshot()` merges:

| Pass | Source | Notes |
|------|--------|-------|
| Text | `parseInventoryCounts` / `extractItemQuantitiesFromText` | `Item x 25`, `25 x Item`, multiline detail panels |
| DOM static | `title` / `aria-label` / `alt`, `data-tooltip`, **image slug → item name** | CDN filenames like `oak-log.png` → `Oak Log` |
| Tooltip hover | `.tippy-content` after hovering slot buttons | IdleMMO uses Tippy for item names |
| Click-through | Up to 60 slot buttons → detail panel / dialog text | Fallback when badges are numeric-only |

`sanitizeInventoryCounts` drops page-chrome false positives (e.g. `Code of Conduct` → `Cod`). **`baitOwned` sticky trust (§4.7) remains** as a safety net when scrape still misses Cheap Bait.

**What overseers should watch:** `decisions.jsonl` with empty `inventory: {}` while `market_sell_half` / `cook_cod` should fire — check `/inventory` DOM changes before weakening sell floors. Unit tests: `src/snapshot/inventory-scrape.test.ts`.

---

## 5. Early-systems playbook stages

When `EARLY_PLAYBOOK` is enabled (default), `evaluatePlaybook()` runs a **repeating batch leveling loop** (`src/autopilot/early-systems-playbook.ts`). Default targets (env-overridable): **100 Coal Ore**, **100 Raw Cod**, **100 Cooked Cod**, **~120 hunt/battle**, then loop back to mining. **Pets are async/opportunistic** (soft prefer / interrupt every N cycles when idle) — they are **not** a sequential stage and do **not** gate batch completion. Hard stage gates use **real counts only** (inventory/playbook counters) — busy-cycle estimates never advance past mine_coal / fish_cod / cook_cod / hunt_rabbits. Override with `PLAYBOOK_COAL_TARGET`, `PLAYBOOK_FISH_TARGET`, `PLAYBOOK_COOK_TARGET`, `PLAYBOOK_HUNT_TARGET`, `PLAYBOOK_PETS_EVERY_N_CYCLES`.

| Stage ID | Goal | Primary actions |
|----------|------|-----------------|
| `mine_coal` | Mine ~100 Coal Ore | `mine_coal` (interrupts Oak/Yew woodcutting) |
| `sell_half` | Early gold via missions first; careful sell as fallback | `quest_turnin`, `quest_talk_accept`, then `sell_junk_for_gold` / `market_sell_half` |
| `buy_bait` | Buy Cheap Bait (gold only, 2g) | `buy_bait` |
| `fish_cod` | Fish ~100 Raw Cod | `fish_cod`, `buy_bait` if missing |
| `cook_cod` | Cook ~100 Cod → Cooked Cod with Coal | `cook_cod` (`src/deterministic/cook.ts`) |
| `sell_extras` | Missions-first gold; sell extras as fallback | `quest_turnin`, `quest_talk_accept`, then `market_sell_half`, `sell_junk` |
| `hunt_rabbits` | Hunt/battle ~120 times with pre-battle FOOD Add | `hunt_rabbits` (calls `selectBattleFood` + combat round); respects `huntFoundCap` |
| `explore_map` | One map peek on the first cycle | `explore_map` |
| *(loop)* | After hunt target met → reset batch counters → `mine_coal` | Does **not** retire to `complete`; pets are **not** required |
| *(async)* `manage_pets` | Claim / feed / battle / sleep pets | Soft prefer / interrupt when idle every N cycles (`PLAYBOOK_PETS_EVERY_N_CYCLES`, default 1); `src/deterministic/pets.ts` — does **not** block the batch |

**Missions-first early gold:** While the early playbook is active, prefer `quest_turnin` and `quest_talk_accept` over `market_sell_half`, `sell_junk_for_gold`, and `sell_junk` when quests are available. Market sell remains fallback when quests are unavailable or dry. At `sell_half`, the playbook skips straight to `buy_bait` when gold is already ≥ 2g (bait cost) or quests can fund bait without a sell pass.

**Quest curriculum (difficulty vs ability):** `evaluateQuestCurriculum()` in `src/autopilot/quest-curriculum.ts` scores each visible quest from snapshot `acceptedQuests` / `pendingQuests` (progress, combat level, inventory). HttpJev receives `questCurriculum` in the snapshot payload plus `[QUEST HIGH/LOW PRIORITY]` tags in action criteria. When an easy gather quest is finishable (e.g. **Wood for the Hearth** → accept → `gather_oak` to 150 → `quest_turnin`), playbook filters deprioritize `fish_cod` and hard hunts (`hunt_battle`) until it completes. Hard kill quests (e.g. Goblin Menace 0/30 at combat 1) stay accepted but do not block easy gather preference.

**Pending accept (Hearth 150/150):** `quest_talk_accept` ranks pending cards by progress-met first (e.g. Wood for the Hearth 150/150 beats Goblin Menace), opens the card, waits for detail, then tries **Accept** / **Talk** plus known Hearth dialogue. Easy-complete pending quests interrupt busy gather (replace dialog → Start anyway) so `/quests` is reachable; playbook/Jev drop `continue_current` while that accept is allowed. If Talk enables Turn In, the same execute path or next `quest_turnin` tick finishes the quest.

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

Registered bootstrap action IDs (starting set): `continue_current`, `gather_oak`, `gather_yew`, `mine_coal`, `fish_cod`, `buy_bait`, `cook_cod`, `craft_if_ready`, `market_sell_half`, `sell_junk_for_gold`, `hunt_battle`, `hunt_rabbits`, `quest_talk_accept`, `quest_turnin`, `sell_junk`, `idle`, plus `explore_map`.

HttpJev and ProgressiveStubJev read action descriptions from the registry automatically.

### 6.2 Selling and junk

Default junk: `Burnt Cod`, `Burnt Fish`, `Burnt Salmon`. Override with `JUNK_SELL_ITEMS`. Quest mats and protected items are never sold.

**`sell_junk_for_gold`** (bootstrap action, priority 26) sells surplus gather junk via vendor UI when gold is below `SELL_GOLD_THRESHOLD` (default **800**) or during playbook `sell_half` / `sell_extras` stages. Protections: keeps at least 1 Cod and 1 Cooked Cod for heals, keeps Coal (15) and Oak (5) floors, and skips Cheap Bait when `fish_cod` / `buy_bait` needs it and bait is not yet trusted. HttpJev remains the decision brain; the playbook injects this action ahead of `market_sell_half` on sell stages.

---

## 7. Sibling overseer communication

When multiple Idle MMO **overseer assistants** exist for the same owner (e.g. per-character bots, “Idle MMO 0/1”, Grok + Cursor), they **MUST coordinate via agent-to-agent messages** — not only by waiting for the user to relay status.

**This document (`docs/OVERSEER_BOT_GUIDELINES.md`) is the shared source of truth.** When you learn a new hard rule in production, update this file (and open a PR) so freshly created siblings inherit it.

### 7.1 Notify siblings when you…

| Event | What to send |
|-------|----------------|
| Restart a shared-box autopilot process | Character name, `STORAGE_STATE`, env overrides, PID/log tail if relevant |
| Change **`AUTOPILOT_LOG_DIR`**, **`PLAYBOOK_STATE_PATH`**, or **`STORAGE_STATE`** | Old → new paths; which character/session |
| Land gather / combat / playbook fixes | PR link, branch, what symptom it fixes (e.g. bait loop, fish_cod grace) |
| Create or take over the overnight watch | Watch name, schedule, which character(s) it monitors; confirm others are paused |

Use your platform’s agent-to-agent messaging (Cursor follow-ups, shared automation channels, etc.). Do **not** assume silence means another overseer is idle.

### 7.2 Multi-account and multi-character isolation

Idle MMO allows **up to 5 characters per account** but only **3 active at once** ([wiki](https://wiki.idle-mmo.com/getting-started/introduction)). This repo models:

| Layer | Isolation | Env |
|-------|-----------|-----|
| **Account** (login session) | Separate Playwright `storageState` per account | `STORAGE_STATE` |
| **Character** (in-game alt) | Separate logs + playbook per character | `CHARACTER_NAME` (+ auto paths) |

**Keep both accounts** — do not merge or delete:

| Account | Storage file |
|---------|----------------|
| IdleBocchi | `storage-state.json` |
| HitoriIdle | `storage-state-hitoriidle.json` |

One autopilot process = one browser = one account session = **one active character**. Run alts as separate processes with the same `STORAGE_STATE` but different `CHARACTER_NAME`.

| Rule | Detail |
|------|--------|
| **One enabled overnight watch** | Per **owner/account** — only one active health-watch automation |
| **Unique session per account** | Separate `STORAGE_STATE` per account login — never share between IdleBocchi and HitoriIdle |
| **Unique paths per character** | Separate `AUTOPILOT_LOG_DIR` and `PLAYBOOK_STATE_PATH` per character process |
| **Auto paths when `CHARACTER_NAME` set** | Defaults to `logs/{accountSlug}/{characterSlug}/` (`accountSlug` from storage filename or `ACCOUNT_SLUG`) |
| **Never share playbook state** | Do **not** point two autopilots at the same `playbook-state.json` — stage counters and `baitOwned` will corrupt each other |
| **No duplicate sessions** | Do not run two autopilot processes against the same `storage-state.json` **and** the same character |
| **Respect 3-active limit** | Do not run more than three simultaneous autopilots on the same account unless the fourth character is idle in-game |

Example — IdleBocchi main (auto paths):

```bash
export STORAGE_STATE=./storage-state.json
export CHARACTER_NAME=IdleBocchi
npm run autopilot -- -v --interrupt
# logs → ./logs/idlebocchi/idlebocchi/
```

Example — HitoriIdle alt:

```bash
export STORAGE_STATE=./storage-state-hitoriidle.json
export CHARACTER_NAME=MinerAlt
export AUTOPILOT_LOG_DIR=./logs/hitoriidle/mineralt   # optional — auto-derived when CHARACTER_NAME set
export PLAYBOOK_STATE_PATH=./logs/hitoriidle/mineralt/playbook-state.json
npm run autopilot -- -v --interrupt
```

Legacy single-character runs (no `CHARACTER_NAME`) still work with manual `AUTOPILOT_LOG_DIR` overrides:

```bash
export STORAGE_STATE=./storage-state-idlebocchi.json
export AUTOPILOT_LOG_DIR=./logs/idlebocchi
export PLAYBOOK_STATE_PATH=./logs/idlebocchi/playbook-state.json
npm run autopilot -- -v --interrupt
```

On startup, autopilot calls `ensureActiveCharacter()` after loading the session and **before snapshots** — set `SKIP_CHARACTER_ENSURE=true` only when debugging roster UI. Full UI notes: [CHARACTER_MANAGEMENT.md](./CHARACTER_MANAGEMENT.md).

### 7.3 Skills vs overseer ownership

- **Skills** (Cursor skills, mem0) may be global across repos — do not assume exclusive ownership of shared skills
- **Overnight watches and live autopilot** are **per-character / per-owner** resources — coordinate before starting or restarting
- If another overseer owns the watch, create yours **paused** or skip; message them before taking over

### 7.4 Fresh bot onboarding

New overseers should:

1. Read this file end-to-end (especially §4 hard rules and §4.7–§4.9 operational lessons)
2. Message existing siblings: who you are, which character(s) you supervise, your log/playbook paths
3. Ask whether an overnight watch already exists before creating one
4. Update this doc when you discover a new production rule worth preserving

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
