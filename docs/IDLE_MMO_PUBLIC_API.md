# IdleMMO Public API

The autopilot can read character data from IdleMMO’s [Public API](https://wiki.idle-mmo.com/more/api) and prefer those quantities over the Playwright inventory scrape. Clicks stay on the web client. This bot does not send gameplay writes through the API.

The in-game **API settings** page (account settings) is the full endpoint catalog. The public wiki does not list every path. This client only calls routes that start with `/v1/`.

## Host and auth

Verified without a key: `GET https://api.idle-mmo.com/v1/auth/check` returns `401` with `{"error":"Unauthorized","message":"Bearer token required"}`.

| Item | Value |
|------|--------|
| Base host | `https://api.idle-mmo.com` (`IDLE_MMO_API_BASE` overrides the host, not a guessed path) |
| Auth | `Authorization: Bearer <IDLE_MMO_API_KEY>` |
| User-Agent | `idle-mmo-bot/1.0.0 (Contact: local-overseer)` |
| Rate limit | **20 requests / minute** (standard). Client spaces calls by at least 3s and caches |
| Keys | Created in account settings with scopes. Never commit or log the key |

This repo is a personal autopilot: one owner key in the environment. It does not ask other players for keys, and it does not pool keys to raise the rate limit.

## Environment

| Variable | Default | Role |
|----------|---------|------|
| `IDLE_MMO_API_KEY` | unset | Required to enable API reads. Unset → DOM scrape only |
| `IDLE_MMO_API_BASE` | `https://api.idle-mmo.com` | Host only. A trailing `/v1` is stripped so paths are not doubled |
| `IDLE_MMO_CHARACTER_ID` | from `GET /v1/auth/check` | Optional hashed character id |
| `IDLE_MMO_INVENTORY_PATH` | unset | Documented `/v1/` inventory path copied from API settings. `{hashed_character_id}` is substituted |
| `IDLE_MMO_API_CACHE_MS` | `30000` | Cache TTL for character, action, and inventory bodies |
| `IDLE_MMO_API_MIN_INTERVAL_MS` | `3000` | Minimum gap between HTTP calls (20/min) |

`401` and `429` back off for at least 60s (or `Retry-After` / `X-RateLimit-Reset` when longer). The snapshot loop keeps the DOM scrape and logs one warning. The key is not included in that line.

If `CHARACTER_NAME` is set and the API character name differs, the merge is skipped so an alt’s stacks are not applied to the wrong process.

## Endpoints this client calls

| Method | Path | When |
|--------|------|------|
| GET | `/v1/auth/check` | Wiki example. Resolves the key’s character id, name, and scopes |
| GET | `/v1/character/{hashed_character_id}/information` | Published public route, scope `v1.character.view` (skills, gold, location; inventory only if that JSON already includes an item list) |
| GET | `/v1/character/{hashed_character_id}/current-action` | Published public route, scope `v1.character.current_action` |
| GET | `IDLE_MMO_INVENTORY_PATH` | Only when you set a `/v1/` path from API settings |

`404` on the character, action, or inventory route is treated as “not available” and cached. It does not discard the scrape.

### Inventory path is not guessed

The wiki’s API page points at in-game API settings for the full list. That page redirects to login without a session, and the published scope catalog we could verify (auth check, character information, current action) does **not** include an inventory route. The client will not call a guessed `/v1/.../inventory` URL.

After you open API settings with your key:

1. Copy the documented inventory path (it must start with `/v1/`).
2. Set `IDLE_MMO_INVENTORY_PATH`. Use `{hashed_character_id}` where the doc shows the character id.
3. Enable the inventory scope listed next to that route (`v1.auth.check`, `v1.character.view`, and `v1.character.current_action` are the other scopes this bot uses).

Until that path is set, item quantities stay on the Playwright scrape. If character information already contains an `inventory` / `items` array, those stacks are used without an extra route.

Recognized item lists (otherwise the scrape is kept):

- `{ "items": [{ "name", "quantity" }] }`
- `{ "inventory": [...] }` or `{ "inventory_items": [...] }`
- `{ "data": { "items": [...] } }`
- names in `name` or `item_name`; counts in `quantity`, `qty`, `amount`, or `stack`

`Coal` / `Cod` / `Bait` are stored as `Coal Ore` / `Raw Cod` / `Cheap Bait` so they line up with the scrape and the playbook.

## How a snapshot merges API and scrape

`readGameSnapshot()` still walks the web client. When the API key is set, `applyPublicApiToSnapshot()` then overlays:

| Field | Rule |
|-------|------|
| Inventory | API quantity replaces the scrape for the same item, including `0`. Scrape-only items (for example Oak Log) stay. Null API inventory keeps the scrape map |
| `hasBait` | Recomputed from the merged map when an API inventory was applied |
| Skills, gold, tokens, levels, location | Filled in when the character payload includes them |
| Current action | Applied when the action route reports a busy action. DOM combat phase is left as scraped |
| Failure / key unset / name mismatch | Entire DOM snapshot kept |

A successful inventory overlay logs one line: `[snapshot] API inventory used (N stacks)`. No key, cookie, or hashed id is written.

Cook-before-hunt still uses `needsCookBeforeHunt(snapshot.inventory, cookMin)`. Better Cooked Cod counts are the fix for an undercounted stack. Cook targets and the battle-food floor are unchanged.

## Safety

- Do not commit `.env` or `IDLE_MMO_API_KEY`.
- Do not call routes outside `/v1/`, and do not point this client at the game’s internal web endpoints.
- Do not automate membership or other real-money purchases.
- Reads only. Starting a skill, hunt, or cook is still a Playwright click.
