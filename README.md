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

### Combat

```bash
# Hunt → battle loop; Jev chooses stance, max enemies, flee, stop timing
npm run combat

# Limit rounds; interrupt active gather to start hunt
npm run combat -- --rounds 5 --interrupt
# or FORCE_INTERRUPT=true in .env
```

Combat uses `ensureHuntActive`: **Start Hunt** if idle, **Hunt More** if post-hunt (replace dialog respects `--interrupt`), **Stop** if already hunting, or proceeds when enemy cards / `ENEMIES NEARBY` are already visible. While hunting, the UI shows **Total Enemies Found** metrics (not cards); Jev stops when found ≥ 1, then **Stop** → wait for enemy cards → Battle.

If a gather action is running, **Start Hunt** shows the replace dialog. With default Jev (no interrupt), the bot closes the dialog, logs clearly, and backs off 30s+ instead of spinning forever. Use `--interrupt` to click **Start anyway**.

Add `-v` / `--verbose` to any command to use **ConsoleJev** (logs every decision):

```bash
npm run gather -- -v
```

## Architecture

- **`src/deterministic/`** — pure Playwright click paths (gather, combat, quest, merchant). UI selectors may need updates when the game changes.
- **`src/jev/`** — `JevAdvisor` decision hooks. Default **StubJev** is conservative; **ConsoleJev** logs choices for local debugging.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for Jev hook details and how to plug in a real AI agent.

## Deterministic vs Jev

| Layer | Responsibility |
|-------|----------------|
| Deterministic | Navigate, click buttons, read visible page text |
| Jev | Whether to interrupt gather, stop hunt, stance, max enemies, flee, quest priority |

Conservative default: **do not** replace a running action unless Jev explicitly returns `shouldInterruptGather: true`. **No auto-spend** unless `--buy-bait` / `BUY_BAIT=true`.

## Terms of Service

Automating gameplay may violate Idle MMO's Terms of Service. Use at your own risk. This project is for educational purposes; the authors are not responsible for account actions taken by the game operator.
