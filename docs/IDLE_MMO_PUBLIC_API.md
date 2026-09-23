# IdleMMO Public API

The autopilot can read [IdleMMO’s Public API](https://wiki.idle-mmo.com/more/api) when an API key is configured. Playwright remains the fallback for every snapshot field the API does not return.

This client calls **only** `/v1/` routes whose paths are published on the wiki or in [IdleMMO patch notes](https://web.idle-mmo.com/patch-notes). It does not guess hosts, inventory URLs, or internal web-app routes.

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `IDLE_MMO_API_KEY` | no | Account API key from **Account settings → Public API**. Unset disables the client. Never commit or log it. |
| `IDLE_MMO_API_BASE` | when the key is set | API **origin only** (`https://host`). The wiki does not publish the host. Copy it from the in-game API settings documentation. There is no built-in default. |
| `IDLE_MMO_GUILD_ID` | no | Guild id used only in the documented `/v1/guild/{id}/…` paths. One path segment (`A–Z`, `a–z`, `0–9`, `_`, `-`). |
| `CHARACTER_NAME` | no | Compared with a `name` that appears on the same object as a documented `hashed_id`. A mismatch is logged. Character switching stays on the Playwright flow. |

User-Agent on every request: `idle-mmo-bot/<version> (Contact: local-overseer)`.

Auth header: `Authorization: Bearer <IDLE_MMO_API_KEY>`.

The API is read-only here. This bot does not call write or action endpoints, and it does not spend membership.

## Rate limit

Official limit: **20 requests per minute per account** (not per key). Patch notes also document the `X-RateLimit-Reset` header.

The client:

- Sends one refresh of the callable catalog, then caches it.
- Spaces refreshes so the callable set stays at or under 18 requests per minute (two requests of headroom).
- Serves that cache on later autopilot cycles instead of fetching per click.
- On HTTP 429, waits until `X-RateLimit-Reset` (or 60s) and does not retry inside that window.

## Snapshot merge

`readGameSnapshot()` builds the Playwright snapshot first, then overlays a Public API read.

- A field is replaced only when that read produced it.
- Inventory keys present in an API inventory payload replace the DOM quantity, **including zero**. Keys the API did not list keep the scraped count.
- Guild hall stockpile quantities are stored under `extensions.publicApi.guild` and are **not** copied onto character inventory.
- `flags.sessionValid` stays the browser session flag.
- Cook-before-hunt / `cookMin` / battle-food floors are unchanged. A higher Cooked Cod count from the API is what satisfies the existing threshold.

Console (no secrets):

- `[snapshot] Public API inventory applied (N items)` when an inventory payload was mapped.
- Otherwise one line per refresh naming the routes that were called, plus a note that inventory, action, quests, and combat paths are unpublished.

If the key is set and the base URL is missing or invalid, the client logs that once and keeps the scrape.

## Callable routes

Paths below are quoted from public patch notes or the wiki. Scopes are included only where the notes name them.

| Id | Method and path | Scopes named in public notes | GameSnapshot fields |
|----|-----------------|------------------------------|---------------------|
| `auth-check` | `GET /v1/auth/check` | (not named) | `extensions.publicApi.authOk`. `hashed_id`, `online_status`, and a sibling `name` when those keys are present. |
| `world-locations` | `GET /v1/world/locations/list` | (not named) | `zones`, `location` when an entry has `current: true`, `features.weather`. Unknown JSON does not overwrite location. |
| `guild-activity` | `GET /v1/guild/{id}/activity` | guild endpoint scope **and** `v1.character.characters` | `extensions.publicApi.guild` only. Requires `IDLE_MMO_GUILD_ID`. |
| `guild-energizing-pool` | `GET /v1/guild/{id}/energizing-pool/information` | guild endpoint scope **and** `v1.character.characters` | `extensions.publicApi.guild` only. |
| `guild-hall` | `GET /v1/guild/{id}/hall` | guild endpoint scope **and** `v1.character.characters` | `extensions.publicApi.guild` (stockpile). Not `inventory`. |

`{id}` is the guild id from the environment, not a character id.

## Named resources with no published path

These are described in patch notes. The client lists them on `extensions.publicApi.unavailable` with reason `path-unpublished` and does **not** request them. Adding a path is allowed only after it appears in the in-game API settings docs or another official public note — then put that exact path on the matching entry in `src/api/documented-endpoints.ts`.

| Id | What official notes say | Snapshot fields waiting on a path |
|----|-------------------------|-----------------------------------|
| `character-information` | Equipped pet base name, custom name, pet id, quality, evolution progress. Location details were added to the character endpoint. `last_activity` was removed. | `location`, pet extension, identity. Levels, gold, and skills are **not** confirmed field names — they are not invented. |
| `character-inspection` | `online_status`. `last_activity` deprecated, then removed. | `extensions.publicApi.identity` |
| `inventory` | No inventory route is named. `quantity` / `chance` casting was fixed across endpoints. | `inventory`, `flags.hasBait` (Cooked Cod, Raw Cod, Coal, bait, other stacks) |
| `current-action` | “Characters current action” endpoint, including the world-boss lobby. Health and potion-effect fixes were reported against the API without a schema. | `currentAction`, `flags.gatherBusy`, `flags.inBattle`, `combatPhase` |
| `pets` | Base name vs custom name, `total_experience`, evolution, stat breakdown. Happiness and hunger were removed. Closed pet inventories return **403**. | `extensions.publicApi.pets` (`total_experience` only, once a path exists) |
| `character-pet` | Equipped pet stats. | `extensions.publicApi.pets` |
| `item-inspection` | `upgrade_requirements` hashed item id, alchemy-chest dungeons, effects. | Not an inventory list. |
| `item-search` | Optional `type` filter. | Not used for autopilot quantities. |
| `pet-exchange` | Endpoint added. Path not published. | None. |
| `guild-members` | Members list includes `hashed_id`. | `extensions.publicApi.guild.members` |
| `world-bosses` | World-boss timers should use the Public API. Path not published. | `extensions.publicApi.worldBosses` |

Quests are not named in the wiki or the public patch notes, so there is no quest route in the catalog. Accepted and pending quests stay on the Playwright scrape.

Combat phase, enemy counts, gold, and skill levels are overlaid when a future documented payload maps them. Today those JSON keys are not published, so the scrape remains the source.

## Where this runs

- Client: `src/api/idle-mmo-api.ts`
- Allowlist: `src/api/documented-endpoints.ts`
- Merge: `src/snapshot/merge-public-api.ts`, called at the end of `readGameSnapshot()`

Tests mock `fetch`. They do not call IdleMMO.
