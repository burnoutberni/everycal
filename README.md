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

## Timezone interoperability

- **ActivityPub outbound**: emits `Event.startTime` and `Event.endTime` as absolute UTC (`...Z`) for compatibility.
- **ActivityPub timezone extension**: includes `eventTimezone` (when known) with an inline EveryCal JSON-LD context mapping.
- **ActivityPub inbound fallback**: if no IANA timezone is provided, stores derivable UTC instants (`Z`/offset input) and marks timezone precision as unknown or offset-only.
- **iCalendar import/export**: supports `TZID`, generated `VTIMEZONE`, UTC fallback output, and RFC5545 all-day `VALUE=DATE` with end-exclusive `DTEND`.

## License

[AGPL-3.0-only](LICENSE)
