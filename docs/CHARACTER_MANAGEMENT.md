# Multi-account and multi-character setup

Idle MMO supports **up to 5 characters per account**, with **up to 3 active at once** ([Getting Started wiki](https://wiki.idle-mmo.com/getting-started/introduction)). This repo keeps **separate login sessions per account** and **separate bot state per character** so alts do not clobber each other.

## Accounts (login sessions)

Each account uses its own Playwright `storageState` file (cookies/session):

| Account | Storage file | Notes |
|---------|--------------|-------|
| IdleBocchi | `storage-state.json` | Default `.env` path |
| HitoriIdle | `storage-state-hitoriidle.json` | Second account — do not merge or delete |

Capture once per account:

```bash
npx playwright codegen https://web.idle-mmo.com --save-storage=storage-state.json
npx playwright codegen https://web.idle-mmo.com --save-storage=storage-state-hitoriidle.json
```

## Characters (in-game alts under one login)

One autopilot process = one browser = one account session = **one active character** at a time.

Set `CHARACTER_NAME` to the in-game display name the process should drive. Log and playbook paths auto-derive unless you override them:

```
logs/{accountSlug}/{characterSlug}/
logs/{accountSlug}/{characterSlug}/playbook-state.json
```

`accountSlug` comes from `ACCOUNT_SLUG` or the `STORAGE_STATE` filename (`storage-state.json` → `idlebocchi`, `storage-state-hitoriidle.json` → `hitoriidle`).

### IdleBocchi main

```bash
export STORAGE_STATE=./storage-state.json
export CHARACTER_NAME=IdleBocchi
npm run autopilot -- -v --interrupt
# Logs → ./logs/idlebocchi/idlebocchi/
```

### HitoriIdle main

```bash
export STORAGE_STATE=./storage-state-hitoriidle.json
export CHARACTER_NAME=HitoriIdle
npm run autopilot -- -v --interrupt
# Logs → ./logs/hitoriidle/hitoriidle/
```

### HitoriIdle alt (example)

```bash
export STORAGE_STATE=./storage-state-hitoriidle.json
export CHARACTER_NAME=MinerAlt
npm run autopilot -- -v --interrupt
# Logs → ./logs/hitoriidle/mineralt/
```

Run alts as **separate processes** (separate terminals or overseer workers). Respect the **3 active characters** game limit — do not start more than three simultaneous autopilots on the same account unless you know the fourth is idle in-game.

## UI path (character list / switch / create)

Documented from the official wiki and in-game nav patterns used elsewhere in this repo:

| Action | Expected UI path | Implementation |
|--------|------------------|----------------|
| Open roster | Nav button **Character** (see `src/deterministic/combat.ts` nav chrome) or `CHARACTER_SELECTOR_ROUTE` | `navigateToCharacterSelect()` |
| List alts | Character roster cards (name + level text) | `listCharacters()` — best-effort scrape |
| Switch | Click character card → **Play** if shown | `selectCharacterByName()` |
| Verify active | `/profile` page heading / label | `readActiveCharacterName()` |
| Create alt | **Create Another Character** on roster | `createCharacter()` — refuses membership/token spend |

**TODO:** Run Playwright codegen against the live character roster and tighten selectors in `src/character/character-select.ts`.

### Env knobs

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHARACTER_NAME` | _(unset)_ | Target character; unset = legacy single-character mode |
| `ACCOUNT_SLUG` | from `STORAGE_STATE` | Override account folder name |
| `SKIP_CHARACTER_ENSURE` | `false` | Skip bootstrap character switch |
| `CHARACTER_SELECTOR_ROUTE` | _(unset)_ | Direct URL to roster (e.g. `/character`) |
| `CREATE_CHARACTER_IF_MISSING` | `false` | Create alt when missing (safe defaults only) |
| `CHARACTER_DEFAULT_CLASS` | `Miner` | Class when auto-creating |

## Bootstrap behavior

On each browser session, autopilot calls `ensureActiveCharacter()` **before the first snapshot**:

1. Load session from `STORAGE_STATE`
2. If `CHARACTER_NAME` is set, read active name from `/profile`
3. Switch via character roster when mismatched
4. Optionally create when `CREATE_CHARACTER_IF_MISSING=true`
5. Continue into the normal snapshot → Jev → execute loop

Legacy runs without `CHARACTER_NAME` behave exactly as before.

## Path overrides

Explicit env always wins over auto-derivation:

```bash
export AUTOPILOT_LOG_DIR=./logs/custom
export PLAYBOOK_STATE_PATH=./logs/custom/playbook-state.json
```

Never point two processes at the same `playbook-state.json` or `storage-state.json` concurrently.
