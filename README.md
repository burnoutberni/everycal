# EveryCal

Federated event calendar built on [ActivityPub](https://www.w3.org/TR/activitypub/).

EveryCal lets you host your own event server, publish rich event pages, follow local and remote accounts, import venue events with scrapers, and expose JSON/iCal feeds.

## Repository layout

- `packages/server`: Hono API, SSR entrypoint, SQLite, ActivityPub federation
- `packages/web`: React + Vike frontend (SSR + client routing)
- `packages/core`: shared types and utilities
- `packages/scrapers`: scraper framework and venue integrations
- `packages/jobs`: scheduled scraper and reminder jobs
- `packages/wordpress`: optional WordPress Gutenberg feed block

WordPress plugin documentation:

- `packages/wordpress/readme.txt`: WordPress.org plugin readme (installation/FAQ/changelog)
- `packages/wordpress/README.md`: developer and operator guide
- `packages/wordpress/docs/HOOKS.md`: filter hooks reference

## Requirements

- Node.js >= 22
- pnpm >= 10

## Quick start (development)

```bash
pnpm install
pnpm dev
```

Starts the app at `http://localhost:3000` with Vite mounted in-process for SSR/frontend development.

## Build and run

```bash
pnpm build
pnpm --filter @everycal/server start
```

## Docker

```bash
docker compose up -d --build
```

Container defaults:

- Runs as non-root (UID 1001)
- Serves API and SSR web app from one process
- Runs background jobs by default (`RUN_JOBS_INTERNALLY=true`)

## Core environment variables

- `BASE_URL`: public base URL used for federation links
- `PORT`: server port (default `3000`)
- `DATABASE_PATH`: SQLite database path (default `/data/everycal.db` in Docker)
- `UPLOAD_DIR`: upload storage directory
- `OG_DIR`: generated Open Graph image directory
- `CORS_ORIGIN`: comma-separated allowlist for authenticated/private surfaces
- `RUN_JOBS_INTERNALLY`: run jobs in same container (`true`/`false`)
- `SCRAPER_API_KEYS_FILE` or `SCRAPER_API_KEYS_JSON`: scraper auth mapping
- `OUTBOUND_RETAIN_DELIVERED_DAYS`: retention window for delivered outbound queue rows (default `30`)
- `OUTBOUND_RETAIN_FAILED_DAYS`: retention window for failed outbound queue rows (default `90`)
- `OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS`: terminal outbound cleanup interval (default `3600000`, minimum `60000`)
- `INBOX_PROCESSED_RETAIN_DAYS`: retention window for `processed` inbox dedupe rows (default `30`)
- `INBOX_FAILED_RETAIN_DAYS`: retention window for `failed` inbox dedupe rows (default `90`)
- `INBOX_PROCESSED_MAX_ROWS`: optional cap for total terminal dedupe rows (`processed` + `failed`), newest rows kept first (default `0`, disabled)
- `INBOX_PROCESSED_CLEANUP_INTERVAL_MS`: inbox dedupe cleanup interval (default `3600000`, minimum `60000`)

CORS behavior:

- Public feeds (`GET /api/v1/feeds/:username.json` and `.ics`) use wildcard CORS (`Access-Control-Allow-Origin: *`), no credentials, and short shared-cache headers.
- Authenticated/private feeds (`/api/v1/private-feeds/calendar-url`, `/api/v1/private-feeds/calendar.ics?token=...`) use strict allowlist CORS from `CORS_ORIGIN` with credentials support for the web UI.

## Scrapers

1. Start the app.
2. Create scraper accounts and keys:

```bash
./scripts/setup-scraper-accounts.sh http://localhost:3000
```

3. Run scrapers once locally:

```bash
pnpm job:scrapers:once
```

4. Or let Docker jobs run on schedule.

## Useful commands

```bash
pnpm lint
pnpm test
pnpm --filter @everycal/server test
pnpm --filter @everycal/web build
```

## Embeddable button

- `Show on EveryCal` web component script: `packages/web/public/embed/show-on-everycal.js`
- Usage and design spec: `docs/show-on-everycal-button.md`

## Timezone interoperability

- **ActivityPub outbound**: emits `Event.startTime` and `Event.endTime` as absolute UTC (`...Z`) for compatibility.
- **ActivityPub timezone extension**: includes `eventTimezone` (when known) with an inline EveryCal JSON-LD context mapping.
- **ActivityPub inbound fallback**: if no IANA timezone is provided, stores derivable UTC instants (`Z`/offset input) and marks timezone precision as unknown or offset-only.
- **iCalendar import/export**: supports `TZID`, generated `VTIMEZONE`, UTC fallback output, and RFC5545 all-day `VALUE=DATE` with end-exclusive `DTEND`.

## License

[AGPL-3.0-only](LICENSE)

## Federation reliability and operations

EveryCal's ActivityPub federation is complete for event create/update/delete, delivery reliability, replay protection, pull-sync parity, and RSVP/attendance interactions.

- **Remote visibility preservation**: inbound inbox ingest and `/api/v1/federation/fetch-actor` pull imports derive remote event visibility from ActivityPub `to`/`cc` addressing. `public`, `unlisted`, `followers_only`, and `private` values are stored with remote events and returned in API serializers.
- **Outbound addressing**: local event `visibility` is centrally mapped to ActivityPub audiences. `public` sends Public in `to` and followers in `cc`; `unlisted` sends followers in `to` and Public in `cc`; `followers_only` sends followers in `to`; `private` emits no broad ActivityPub audience.
- **Pull-sync parity**: remote outbox imports process `Create`, `Announce`, `Update(Event)`, `Delete`, and RSVP interactions targeting local Event objects. Update and delete imports validate that the outbox actor owns the event before mutating local remote-event state; pulled RSVPs validate that the outbox actor is the RSVP actor before mutating attendance.
- **RSVP federation mapping**: inbound `Accept` and `Join` map to `going`; `TentativeAccept` maps to `maybe`; `Reject` and `Leave` map to a non-attending tombstone (`not_going`) for remote attendees. Local outbound RSVP changes emit `Accept` for `going`, `TentativeAccept` for `maybe`, and `Leave` for clearing an RSVP. Unknown RSVP verbs are no-ops with bounded logs.
- **RSVP ordering and replay behavior**: stable inbound activity ids use the shared `processed_inbox_activities` claim/processed flow, so duplicate deliveries do not reapply mutations. RSVP rows also store the last activity type, id, published timestamp, and precedence; newer `published`/`updated` timestamps win, and equal or missing timestamps converge by precedence (`Leave` > `Reject` > `TentativeAccept` > `Accept` > `Join`) so reordered delivery is deterministic. Activities without stable ids are processed conservatively through the same convergent upsert and logged without creating unbounded replay work.
- **Durable outbound retries**: follower delivery is persisted to `outbound_activity_deliveries` and processed by a periodic worker. Successful deliveries are marked `delivered`; transient failures remain `pending` with exponential backoff; exhausted jobs become `failed` with `last_error` for inspection.
- **Inbox idempotency**: successfully handled inbox activities with stable ActivityPub `id` values are recorded in `processed_inbox_activities`. Duplicate replays for the same actor and target inbox are skipped without reapplying mutations. Activities without stable ids are still processed and logged.

### Operator runbook: federation queue and replay health

**Queue health inspection**

```sql
SELECT state, COUNT(*) AS jobs
FROM outbound_activity_deliveries
GROUP BY state;

SELECT id, destination_inbox, sender_actor_uri, attempt_count, next_retry_at, last_error
FROM outbound_activity_deliveries
WHERE state IN ('pending','failed')
ORDER BY state, datetime(next_retry_at)
LIMIT 50;
```

**Retry/backoff policy**

- The in-process worker runs every `OUTBOUND_DELIVERY_INTERVAL_MS` milliseconds (default: `30000`).
- Jobs start in `pending`, are attempted immediately, and retry with exponential backoff from a 60-second base.
- After 5 failed attempts, jobs move to terminal `failed` state and log a permanent-failure message.
- Built-in cleanup prunes old terminal rows on a schedule: `delivered` rows older than `OUTBOUND_RETAIN_DELIVERED_DAYS` and `failed` rows older than `OUTBOUND_RETAIN_FAILED_DAYS`.
- Cleanup runs every `OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS` (default hourly). Set retention env vars higher if you need longer investigation windows.
- Inbox dedupe cleanup prunes terminal rows (`processed`/`failed`) older than `INBOX_PROCESSED_RETAIN_DAYS` / `INBOX_FAILED_RETAIN_DAYS`, and can cap table growth with `INBOX_PROCESSED_MAX_ROWS`.

**Built-in observability endpoint**

Authenticated users can inspect queue and dedupe health:

```bash
curl -H "Cookie: everycal_session=..." \
  http://localhost:3000/api/v1/federation/queue-health
```

Response includes outbound queue state counts (`pending`/`processing`/`failed`/`delivered`), oldest pending retry age in seconds, and `processed_inbox_activities` totals/status mix plus oldest/newest `received_at`.

**Replay/idempotency verification**

```sql
SELECT actor_uri, target_context, COUNT(*) AS processed, MAX(received_at) AS last_seen
FROM processed_inbox_activities
GROUP BY actor_uri, target_context
ORDER BY datetime(last_seen) DESC
LIMIT 50;

SELECT activity_id, actor_uri, target_context, received_at
FROM processed_inbox_activities
WHERE activity_id = 'https://remote.example/activity/id';
```

If a remote retries the same signed activity, the row count for that `activity_id` should remain one per `(actor_uri, target_context)` and the affected event/follow state should not change after the first successful processing.


**RSVP federation troubleshooting**

```sql
SELECT event_id, actor_uri, status, last_activity_type, last_activity_id,
       last_activity_published_at, updated_at
FROM remote_event_rsvps
ORDER BY datetime(updated_at) DESC
LIMIT 50;

SELECT destination_inbox, sender_actor_uri, activity_json, state, last_error
FROM outbound_activity_deliveries
WHERE activity_json LIKE '%"type":"Accept"%'
   OR activity_json LIKE '%"type":"TentativeAccept"%'
   OR activity_json LIKE '%"type":"Leave"%'
ORDER BY datetime(created_at) DESC
LIMIT 50;
```

For inbound RSVP issues, verify the target object is a local `BASE_URL/events/:id` Event, the local event exists, the Event object's `attributedTo` (when supplied) matches the local event owner, and any object-level actor matches the activity actor. For outbound RSVP issues, verify the remote event owner resolves to an inbox and that the local account has a keypair; delivery then follows the normal outbound queue retry policy.

**Migration rollout and rollback notes**

- The migration sequence is additive for RSVP federation: it adds `remote_event_rsvps` plus lookup indexes for remote attendees of local events. Earlier federation hardening migrations added `remote_events.visibility`, `processed_inbox_activities`, and supporting indexes, and include a data-preserving rebuild/normalization step for `outbound_activity_deliveries` (`CREATE ..._tmp` + `INSERT` + `DROP` + `RENAME`).
- Legacy remote events are safely backfilled to `public` because older EveryCal releases treated remote events as public.
- Roll forward before enabling RSVP federation interactions so update/delete pull parity, replay protection, and the `remote_event_rsvps` table are all active.
- Rollback to an older binary should leave the resulting tables/columns in place; older binaries will ignore `remote_event_rsvps` but should not drop it. Avoid destructive schema rollback unless you have exported or intentionally discarded queued outbound deliveries and processed-inbox audit rows, and take a DB backup first if you may need to restore pre-migration state.
