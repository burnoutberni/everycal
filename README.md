# EveryCal

Federated event calendar built on [ActivityPub](https://www.w3.org/TR/activitypub/).

EveryCal lets you run your own event server, publish rich event pages, follow local and remote accounts, import venue events via scrapers, and expose JSON/iCal feeds.

## What is in this repo

- `packages/server` - Hono API + SSR entry + SQLite + ActivityPub federation
- `packages/web` - React + Vike frontend (SSR + client routing)
- `packages/core` - shared types and utilities
- `packages/scrapers` - scraper framework + venue integrations
- `packages/jobs` - scheduled scraper/reminder jobs
- `packages/wordpress` - optional WordPress Gutenberg feed block

## Requirements

- Node.js >= 22
- pnpm >= 10

## Quick start (development)

```bash
pnpm install
pnpm dev
```

This starts the server on `http://localhost:3000` and mounts Vite in-process for SSR/frontend dev.

## Build and run

```bash
pnpm build
pnpm --filter @everycal/server start
```

## Docker

```bash
docker compose up -d --build
```

Container behavior:

- runs as non-root (UID 1001)
- serves API + SSR web app from one process
- runs background jobs by default (`RUN_JOBS_INTERNALLY=true`)

## Core environment variables

- `BASE_URL` - public base URL used for federation links
- `PORT` - server port (default `3000`)
- `DATABASE_PATH` - SQLite path (default `/data/everycal.db` in Docker)
- `UPLOAD_DIR` - upload storage directory
- `OG_DIR` - generated Open Graph image directory
- `CORS_ORIGIN` - comma-separated allowed origins
- Public feed embeds: `GET /api/v1/feeds/:username.json` (and `.ics`) now use wildcard CORS for browser embeds (`Access-Control-Allow-Origin: *`, no credentials) and short cache headers suitable for shared caches.
- Authenticated/private feed surfaces (`/api/v1/private-feeds/calendar-url`, `/api/v1/private-feeds/calendar.ics?token=...`) remain on strict allowlist CORS from `CORS_ORIGIN` with credentials support for the web UI.
- `RUN_JOBS_INTERNALLY` - run jobs in same container (`true`/`false`)
- `SCRAPER_API_KEYS_FILE` or `SCRAPER_API_KEYS_JSON` - scraper auth mapping

## Scrapers

1. Start the app.
2. Create scraper accounts and keys:

```bash
./scripts/setup-scraper-accounts.sh http://localhost:3000
```

3. Run once locally:

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

## Timezone interoperability notes

- **ActivityPub outbound**: EveryCal emits `Event.startTime` / `Event.endTime` as absolute UTC (`...Z`) for compatibility.
- **ActivityPub timezone extension**: when known, EveryCal includes `eventTimezone` with an inline EveryCal JSON-LD context mapping.
- **ActivityPub inbound fallback**: if no IANA timezone is provided, EveryCal stores UTC instants when derivable (for `Z`/offset input) and marks timezone precision as unknown or offset-only.
- **iCalendar import/export**: feeds now support `TZID`, generated `VTIMEZONE`, UTC fallback output, and RFC5545 all-day `VALUE=DATE` with end-exclusive `DTEND`.

## License

[AGPL-3.0-only](LICENSE)
