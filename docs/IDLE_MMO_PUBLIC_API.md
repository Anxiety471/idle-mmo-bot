# IdleMMO Public API

The autopilot reads the official Public API when `IDLE_MMO_API_KEY` is set. Playwright still builds the snapshot first. The API overlays only fields it actually returned.

Source of truth for paths, scopes, and example fields: the in-game page **Account settings → Public API** (`https://web.idle-mmo.com/settings/api`), extracted 2026-09-23. This client calls only those `/v1` routes. It does not call internal web-app routes.

## Origin and auth

| Item | Value |
|------|--------|
| Default origin | `https://api.idle-mmo.com` |
| Paths | Under `/v1` (the settings page shows base `https://api.idle-mmo.com/v1`) |
| Auth | `Authorization: Bearer <IDLE_MMO_API_KEY>` |
| Accept | `application/json` |
| User-Agent | `idle-mmo-bot/<version> (Contact: local-overseer)` |
| Rate limit | 20 requests per minute per account |
| Timestamps | UTC ISO 8601 |

`IDLE_MMO_API_BASE` overrides the origin only (`https://host`, no path, query, hash, or credentials). Unset uses `https://api.idle-mmo.com`.

The API is read-only here. This bot does not call write or action endpoints.

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `IDLE_MMO_API_KEY` | no | Account API key from **Account settings → Public API**. Unset disables the client. Never commit or log it. |
| `IDLE_MMO_API_BASE` | no | HTTPS origin override. Default `https://api.idle-mmo.com`. |
| `IDLE_MMO_CHARACTER_HASHED_ID` | no | `hashed_character_id` path segment for `/v1/character/{hashed_character_id}/…`. One segment (`A–Z`, `a–z`, `0–9`, `_`, `-`). |
| `CHARACTER_NAME` | no | When the hashed id is unset, auth/check (and, if needed, alt characters) must include this name next to a `hashed_id`. A later name mismatch on character information is logged. Character switching stays on the Playwright flow. |
| `IDLE_MMO_GUILD_ID` | no | Guild id for allowlisted `/v1/guild/{id}/…` paths. Those routes are not called on the autopilot refresh wave. |

### How `hashed_character_id` is chosen

1. `IDLE_MMO_CHARACTER_HASHED_ID` when it is a single safe path segment.
2. Otherwise `GET /v1/auth/check`. A `hashed_id` is used only when its sibling `name` matches `CHARACTER_NAME`, or when `CHARACTER_NAME` is unset and the payload has exactly one named character.
3. If `CHARACTER_NAME` is set and auth/check did not match, `GET /v1/character/{seed}/characters` is called with a hashed id from auth/check. The named alt is then used for information, current action, and pets.

Several named characters and no `CHARACTER_NAME` or hashed id is ambiguous. The client does not guess, and it does not call the character routes.

## Rate limit

Official limit: **20 requests per minute per account**.

The client:

- Refreshes a small wave, then caches it.
- Spaces refreshes so that wave stays at or under 18 requests per minute (two requests of headroom).
- With a configured character hash the wave is 3 calls (information, current action, pets). Without one it can be 5 (auth check, alt characters, then those three).
- Serves the cache on later autopilot cycles.
- On HTTP 429, waits until `X-RateLimit-Reset` (or 60s) and does not retry inside that window.
- Calls pets on the same wave only when the local budget still has a slot. Item catalog and combat list routes are never part of the wave.

## Snapshot merge

`readGameSnapshot()` builds the Playwright snapshot first, then overlays this read.

- A field is replaced only when that read produced it.
- `flags.sessionValid` stays the browser session flag.
- Cook-before-hunt / `cookMin` / battle-food floors are unchanged.

Character information maps documented example fields only:

| API field | Snapshot |
|-----------|----------|
| `gold` | `gold` |
| `tokens` | `tokens` |
| `total_level` | `totalLevel` |
| `skills.*.level` | `skillLevels` for woodcutting, mining, fishing, alchemy, smelting, cooking, forge, construction |
| `location.name` (or a string location) | `location` |
| `equipped_pet` `id`, `name`, `custom_name`, `quality`, `evolution` | `extensions.publicApi.equippedPet` |
| `current_status` | `extensions.publicApi.identity.currentStatus` (not combat phase, not `inBattle`) |
| `name`, `hashed_id` | `extensions.publicApi.identity` |

Current action maps `type`, `item`, `title`, `started_at`, `expires_at` onto `currentAction` (`type`, `resource`, `label`, `startedAt`, `expiresAt`). A known type such as `MINING` also sets `currentAction.skill`. An active `type` sets `flags.gatherBusy`. An empty action clears it. `image_url` is ignored. The example has no battle fields, so this route does not set `combatPhase`, `flags.inBattle`, enemy counts, or health.

Pets from `GET /v1/character/{hashed_character_id}/pets` are stored on `extensions.publicApi.pets` using the example fields `id`, `name`, `custom_name`, `pet_id`, `level`, `experience`, `total_experience`, `quality`, `stats`, `health`, `happiness`, and `equipped`.

Console (no secrets), once per distinct line:

- `[snapshot] Public API read <route ids>; inventory remains Playwright scrape`
- On total failure: `[snapshot] Public API failed (<code>); Playwright scrape kept`

## Inventory stays on the scrape

The official settings page has **no character inventory endpoint**. There is no `/v1/.../inventory` (or bag) route in the 24 available endpoints.

Cooked Cod, Raw Cod, Coal, bait, and every other bag stack stay on the Playwright inventory scrape. The client never writes `patch.inventory`. Guild hall stock is not character food. Museum quantities and `battle.food_used` metrics are not bag stacks and are not polled.

Do not lower `cookMin`, cook-before-hunt, or the battle-food floor because the API does not return food counts.

Quests are not listed on the official page. Accepted and pending quests stay on the scrape. Combat phase and enemy counts stay on the scrape.

## Refresh wave

Called when a character id is known, in order:

1. `GET /v1/character/{hashed_character_id}/information` (`v1.character.view`) — priority
2. `GET /v1/character/{hashed_character_id}/current-action` (`v1.character.current_action`) — priority
3. `GET /v1/character/{hashed_character_id}/pets` (`v1.character.pets`) — same wave if budget allows

Resolution calls, only when the hashed id is not configured:

- `GET /v1/auth/check` (`v1.auth.check`)
- `GET /v1/character/{hashed_character_id}/characters` (`v1.character.characters`) when the name was not on auth/check

Not called every cycle (allowlisted, so a path check still accepts them): item search, item inspect, item market history, world bosses, dungeons, enemies, world locations, character metrics, effects, museum, companion exchange, guild routes, shrine progress.

## Allowlist (24)

| Method | Name | Path | Scope |
|--------|------|------|-------|
| `GET` | Authentication Check | `/v1/auth/check` | `v1.auth.check` |
| `GET` | World Locations List | `/v1/world/locations/list` | `v1.world.locations.list` |
| `GET` | World Bosses List | `/v1/combat/world_bosses/list` | `v1.combat.world_bosses.list` |
| `GET` | Dungeons List | `/v1/combat/dungeons/list` | `v1.combat.dungeons.list` |
| `GET` | Enemies List | `/v1/combat/enemies/list` | `v1.combat.enemies.list` |
| `GET` | Item Search | `/v1/item/search` | `v1.item.search` |
| `GET` | Item Inspection | `/v1/item/{hashed_item_id}/inspect` | `v1.item.inspect` |
| `GET` | Item Market History | `/v1/item/{hashed_item_id}/market-history` | `v1.item.market_history` |
| `GET` | Character View | `/v1/character/{hashed_character_id}/information` | `v1.character.view` |
| `GET` | Character Metrics | `/v1/character/{hashed_character_id}/metrics` | `v1.character.metrics` |
| `GET` | Character Effects | `/v1/character/{hashed_character_id}/effects` | `v1.character.effects` |
| `GET` | Character Alt Characters | `/v1/character/{hashed_character_id}/characters` | `v1.character.characters` |
| `GET` | Character Museum | `/v1/character/{hashed_character_id}/museum` | `v1.character.museum` |
| `GET` | Character Current Action | `/v1/character/{hashed_character_id}/current-action` | `v1.character.current_action` |
| `GET` | Character Pets | `/v1/character/{hashed_character_id}/pets` | `v1.character.pets` |
| `GET` | Companion Exchange Listings | `/v1/pets/companion-exchange/listings` | `v1.pets.companion_exchange.listings` |
| `GET` | Guild Information | `/v1/guild/{id}/information` | `v1.guild.information` |
| `GET` | Guild Members | `/v1/guild/{id}/members` | `v1.guild.members` |
| `GET` | Guild Activity | `/v1/guild/{id}/activity` | `v1.guild.activity` |
| `GET` | Guild Energizing Pool Information | `/v1/guild/{id}/energizing-pool/information` | `v1.guild.energizing_pool.information` |
| `GET` | Guild Hall | `/v1/guild/{id}/hall` | `v1.guild.hall` |
| `GET` | Guild Conquest | `/v1/guild/conquest/view` | `v1.guild.conquest.view` |
| `GET` | Guild Conquest Zone Inspection | `/v1/guild/conquest/zone/{zone_id}/inspect` | `v1.guild.conquest.zone.inspect` |
| `GET` | Shrine Progress | `/v1/shrine/progress` | `v1.shrine.progress` |

Item search, inspect, and market history are a global catalog. They are not per-character inventory.

## Where this runs

- Client: `src/api/idle-mmo-api.ts`
- Allowlist: `src/api/documented-endpoints.ts`
- Merge: `src/snapshot/merge-public-api.ts`, called at the end of `readGameSnapshot()`

Tests mock `fetch`. They do not call IdleMMO.
