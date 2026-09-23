# Idle MMO Bot

TypeScript + Playwright automation for [Idle MMO](https://web.idle-mmo.com/). Deterministic UI flows handle clicking; a **Jev** advisor interface decides when to interrupt, flee, or prioritize quests.

## Requirements

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

## Session / cookies

The bot needs a logged-in or guest browser session. Capture Playwright `storageState` once from a browser where you are already signed in:

```bash
# Example: interactive login then save state
npx playwright codegen https://web.idle-mmo.com --save-storage=storage-state.json
```

Set `STORAGE_STATE=./storage-state.json` in `.env`. This file is gitignored — never commit it.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `https://web.idle-mmo.com` | Game web client URL |
| `POLL_MS` | `5000` | Poll interval (ms) for gather/combat loops |
| `HEADLESS` | `true` | Run Chromium headless |
| `STORAGE_STATE` | _(unset)_ | Path to saved session JSON |
| `BUY_BAIT` | `false` | Auto-buy Cheap Bait when fishing (off by default) |
| `FORCE_INTERRUPT` | `false` | Click Start anyway on replace dialog for combat |
| `JEV_API_TOKEN` | _(unset)_ | TypeSafe API key for **HttpJev** (alias: `TYPESAFE_API_KEY`) |
| `JEV_MODEL` | `jev-latest` | Jev model sent to TypeSafe System One API |
| `JEV_NOUL_THRESHOLD` | `0.6` | Noul yes threshold for interrupt / flee |
| `HUNT_FOUND_CAP` | `100` | Stop hunting and battle when **Total Enemies Found** reaches this count |
| `IDLE_MMO_API_KEY` | _(unset)_ | Optional Public API key. Enables read-only `/v1` snapshot data. Never commit it. |
| `IDLE_MMO_API_BASE` | `https://api.idle-mmo.com` | Public API origin (`https://host`, no path). Override only if the in-game docs show a different host. |
| `IDLE_MMO_CHARACTER_HASHED_ID` | _(unset)_ | `hashed_character_id` for character information, current action, and pets. Otherwise resolved from auth/check using `CHARACTER_NAME`. |
| `IDLE_MMO_GUILD_ID` | _(unset)_ | Optional guild id for allowlisted `/v1/guild/{id}/…` paths. Not polled every cycle. Not character inventory. |

## Commands

### Skill gathering & crafting

Skill pages live at `/skills/view/<skill>`. The bot waits for `CURRENT ACTION` or idle controls after navigation, then polls busy/idle and restarts the chosen resource when idle. Replace dialog defaults to **Close**; **Start anyway** only when Jev allows interrupt.

```bash
# Woodcutting — Oak Log (backward-compatible alias)
npm run gather

# Unified skill command
npm run skill -- --skill mining --resource "Coal Ore"
npm run skill -- --skill fishing --resource Cod
npm run skill -- --skill woodcutting --resource "Yew Log"

# Crafting skills (require --resource until labels confirmed in playbook)
npm run skill -- --skill alchemy --resource "Item Name"
npm run skill -- --skill smelting --resource "Item Name"
npm run skill -- --skill cooking --resource "Item Name"
npm run skill -- --skill forge --resource "Item Name"
npm run skill -- --skill construction --resource "Item Name"

# Thin npm aliases
npm run mine          # mining → Coal Ore (default)
npm run fish          # fishing → Cod (default)
```

| Skill | URL | Default resource | Notes |
|-------|-----|------------------|-------|
| woodcutting | `/skills/view/woodcutting` | Oak Log | Yew Log |
| mining | `/skills/view/mining` | Coal Ore | Tin Ore, Limestone (Lv.10) |
| fishing | `/skills/view/fishing` | Cod | Salmon, Tuna; needs Cheap Bait |
| alchemy | `/skills/view/alchemy` | _(requires `--resource`)_ | |
| smelting | `/skills/view/smelting` | _(requires `--resource`)_ | |
| cooking | `/skills/view/cooking` | _(requires `--resource`)_ | |
| forge | `/skills/view/forge` | _(requires `--resource`)_ | |
| construction | `/skills/view/construction` | _(requires `--resource`)_ | |

**Fishing bait:** Cod/Salmon/Tuna require **Cheap Bait** (buy at `/merchants` → General Goods, 2g). By default the bot does **not** purchase bait. If bait is missing (or Start is disabled), the command exits with `missing_requirement`. Opt in to auto-purchase:

```bash
npm run fish -- --buy-bait
# or set BUY_BAIT=true in .env
```

**Global gather slot:** Only one gather/craft action runs at a time. `CURRENT ACTION` only appears on the skill page that owns it. The bot probes other skill pages and backs off (30s+) instead of hammering Start when another action is active.

### Quests

```bash
# Turn in Wood for the Hearth when Oak Log 150/150 / Turn In enabled
# (waits for quest tabs to load; switches Accepted tab — counts like "Accepted 1")
npm run quest-turnin

# Custom quest
npm run quest-turnin -- --quest "Wood for the Hearth" --item "Oak Log"

# Progress all accepted quests (talk + turn in when enabled)
npm run quest

# Gather Oak Logs until Wood for the Hearth can turn in
npm run farm-hearth
```

### Autopilot (progressive / overnight)

`npm run autopilot` runs a **supervisor loop** until SIGINT:

1. Build structured **GameSnapshot** (location, levels, gold, inventory, quests, combat phase). When `IDLE_MMO_API_KEY` is set, documented character information and current action overlay gold, levels, location, and gather state. Inventory (Cooked Cod, bait, and other stacks) stays on the Playwright scrape. See [docs/IDLE_MMO_PUBLIC_API.md](docs/IDLE_MMO_PUBLIC_API.md).
2. Derive **allowed actions** (gather, hunt, quest, craft, sell junk, …)
3. **Jev** chooses one action (`HttpJev` when `JEV_API_TOKEN` set, else **ProgressiveStubJev**)
4. Execute **one** deterministic action, sleep, repeat

Soft goals: keep skills training, advance combat for kill quests, accept/turn-in quests, rotate gather skills, smelt when coal stocked, sell configured junk only.

The **bootstrap action list** (gather, hunt, quest, …) is a starting set — not a hard cap. As the bot explores Idle MMO, unregistered UI features are logged (`[autopilot:discover]`) and new loops are added via `registerDiscoveredAction()` + snapshot enrichers. An overseer agent can supervise logs; multi-bot parties are a future extension on the same per-account hooks.

```bash
export JEV_API_TOKEN=your-key
export STORAGE_STATE=./storage-state.json
npm run autopilot

# Log every Jev decision; force combat interrupt on replace dialog
npm run autopilot -- -v --interrupt
```

Optional: `JUNK_SELL_ITEMS=Burnt Cod,Burnt Fish` (never sells Oak Log, ores, bait).

### Overnight structured logs

Each supervisor tick and Jev call appends one JSON line to gitignored files under `logs/` (override with `AUTOPILOT_LOG_DIR`):

| File | Contents |
|------|----------|
| `decisions.jsonl` | Per tick: timestamp, cycle, snapshot fields (location, gold, levels, inventory, quests, flags, discovered routes), allowed actions, chosen action, execute outcome, backoffMs |
| `jev.jsonl` | Per Jev call: method, model, usage, full answer (choice/noul/score + confidence/probabilities), result, fallback flag + error when API fails |

`pageText` and secrets (API tokens, cookies, storage-state) are never written. Console logs are unchanged.

```bash
# Replay / grep examples
jq -r '.chosenAction' logs/decisions.jsonl | sort | uniq -c
jq 'select(.fallback==true)' logs/jev.jsonl
grep '"method":"chooseNextAction"' logs/jev.jsonl | tail -5
```

An overseer agent can supervise this loop; multi-bot parties are a future extension (hooks are per-account via `JevAdvisor`).

### Combat

```bash
# Hunt → battle loop; Jev chooses stance, max enemies, flee, stop timing
npm run combat

# Limit rounds; interrupt active gather to start hunt
npm run combat -- --rounds 5 --interrupt
# or FORCE_INTERRUPT=true in .env
```

Combat uses `ensureHuntActive`: **Start Hunt** if idle, **Hunt More** if post-hunt (replace dialog respects `--interrupt`), **Stop** if already hunting, or proceeds when enemy cards / `ENEMIES NEARBY` are already visible. While hunting, the UI shows **Total Enemies Found** (enemy sprites may also be visible). That counter is the hunted total. A **hard stop** fires when Total Enemies Found ≥ `HUNT_FOUND_CAP` (default **100**). Example: found **121** with Enemies Remaining **831** battles immediately — remaining enemies do not extend the hunt, and a smaller found count does not battle early. Jev cannot override the cap. Then **Stop** → enemy select → Battle.

If a gather action is running, **Start Hunt** shows the replace dialog. With default Jev (no interrupt), the bot closes the dialog, logs clearly, and backs off 30s+ instead of spinning forever. Use `--interrupt` to click **Start anyway**.

Add `-v` / `--verbose` to any command to log every Jev decision (wraps HttpJev or StubJev):

```bash
npm run gather -- -v
```

### Jev (TypeSafe API)

When `JEV_API_TOKEN` or `TYPESAFE_API_KEY` is set, the CLI uses **HttpJev** — a real advisor that calls `POST https://api.typesafe.ai/v1/systemone` with structured JSON state (no screenshots). Without a token, **StubJev** provides conservative defaults.

| Advisor method | TypeSafe question | Decision rule |
|----------------|-------------------|---------------|
| `shouldInterruptGather` | noul | `true` when noul ≥ `JEV_NOUL_THRESHOLD` |
| `decideHuntStop` | noul | `true` only when Total Enemies Found ≥ cap (default 100) |
| `chooseStance` | choice | Balanced / Offensive / Defensive / Agile / Dexterous |
| `chooseMaxEnemies` | score | 1–5 enemies from ordered rubric |
| `shouldFlee` | noul | `true` when noul ≥ threshold |
| `pickQuestPriority` | choice | quest title or `keep_gathering` (empty list) |

On API failure, HttpJev logs the error and falls back to StubJev behavior.

Smoke-test the API without launching the browser:

```bash
export JEV_API_TOKEN=your-key
npm run jev-smoke
```

## For overseer bots

AI overseers (e.g. Grok Bot / Cursor agents supervising live autopilot) should read **[docs/OVERSEER_BOT_GUIDELINES.md](./docs/OVERSEER_BOT_GUIDELINES.md)** first. It covers bootstrap checklist, architecture, hard rules (hunt cap, pre-battle FOOD, bait trust, gather grace, gather reliability), early-systems playbook stages, log locations, **sibling overseer agent-to-agent coordination**, per-account/per-character isolation, and how to register new actions from discovery output.

Multi-character setup (accounts, `CHARACTER_NAME`, path layout): **[docs/CHARACTER_MANAGEMENT.md](./docs/CHARACTER_MANAGEMENT.md)**.

## Architecture

- **`src/deterministic/`** — pure Playwright click paths (gather, combat, quest, merchant). UI selectors may need updates when the game changes.
- **`src/jev/`** — `JevAdvisor` decision hooks. **StubJev** (default), **HttpJev** (TypeSafe API), **ConsoleJev** (verbose wrapper).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for Jev hook details and TypeSafe API mapping.

## Deterministic vs Jev

| Layer | Responsibility |
|-------|----------------|
| Deterministic | Navigate, click buttons, read visible page text |
| Jev | Whether to interrupt gather, stop hunt, stance, max enemies, flee, quest priority |

Conservative default: **do not** replace a running action unless Jev explicitly returns `shouldInterruptGather: true`. **No auto-spend** unless `--buy-bait` / `BUY_BAIT=true`.

## Terms of Service

Automating gameplay may violate Idle MMO's Terms of Service. Use at your own risk. This project is for educational purposes; the authors are not responsible for account actions taken by the game operator.
