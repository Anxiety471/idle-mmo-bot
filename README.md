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

## Commands

### Skill gathering

Skill pages live at `/skills/view/<skill>` (woodcutting, mining, fishing). The bot waits for `CURRENT ACTION` or idle controls after navigation, then polls busy/idle and restarts the chosen resource when idle. Replace dialog defaults to **Close**; **Start anyway** only when Jev allows interrupt.

```bash
# Woodcutting — Oak Log (backward-compatible alias)
npm run gather

# Unified skill command
npm run skill -- --skill mining --resource "Coal Ore"
npm run skill -- --skill fishing --resource Cod
npm run skill -- --skill woodcutting --resource "Yew Log"

# Thin npm aliases
npm run mine          # mining → Coal Ore (default)
npm run fish          # fishing → Cod (default)
```

| Skill | URL | Default resource | Other resources |
|-------|-----|------------------|-----------------|
| woodcutting | `/skills/view/woodcutting` | Oak Log | Yew Log |
| mining | `/skills/view/mining` | Coal Ore | Tin Ore, Limestone (Lv.10) |
| fishing | `/skills/view/fishing` | Cod | Salmon, Tuna |

**Fishing bait:** Cod/Salmon/Tuna require **Cheap Bait** (buy at `/merchants` → General Goods, 2g). The bot does **not** auto-purchase bait. If bait is missing, the command exits with `missing_requirement` instead of looping on failures.

```bash
# Hunt → battle loop; Jev chooses stance, max enemies, flee, stop timing
npm run combat

# Open quests, talk, turn in when enabled
npm run quest

# Gather Oak Logs until "Wood for the Hearth" can turn in
npm run farm-hearth
```

Add `-v` / `--verbose` to any command to use **ConsoleJev** (logs every decision):

```bash
npm run gather -- -v
```

## Architecture

- **`src/deterministic/`** — pure Playwright click paths (gather, combat, quest). UI selectors may need updates when the game changes.
- **`src/jev/`** — `JevAdvisor` decision hooks. Default **StubJev** is conservative; **ConsoleJev** logs choices for local debugging.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for Jev hook details and how to plug in a real AI agent.

## Deterministic vs Jev

| Layer | Responsibility |
|-------|----------------|
| Deterministic | Navigate, click buttons, read visible page text |
| Jev | Whether to interrupt gather, stop hunt, stance, max enemies, flee, quest priority |

Conservative default: **do not** replace a running action unless Jev explicitly returns `shouldInterruptGather: true`.

## Terms of Service

Automating gameplay may violate Idle MMO's Terms of Service. Use at your own risk. This project is for educational purposes; the authors are not responsible for account actions taken by the game operator.
