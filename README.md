# EveryCal

A federated event calendar built on [ActivityPub](https://www.w3.org/TR/activitypub/). Self-host a server, import events from venue websites via scrapers, browse them in a dark-mode web UI, and embed feeds in WordPress.

## Why?

- **Self-hosted & federated** — your events, your server, connected to everyone else's
- **Privacy-first** — public, unlisted, followers-only, or fully private events
- **Scraper framework** — automatically import events from venue websites, each scraper runs as its own account
- **Web frontend** — dark minimal UI for browsing, creating, and managing events
- **WordPress integration** — Gutenberg block that pulls events from any EveryCal server

## Packages

```
everycal/
├── packages/
│   ├── core/          # Shared types, iCal ↔ ActivityPub conversion
│   ├── server/        # Hono HTTP server + SQLite database
│   ├── scrapers/      # CLI tool + venue scrapers (flex.at, votivkino.at)
│   ├── web/           # React + Vite frontend (dark theme)
│   └── wordpress/     # WordPress plugin with Gutenberg block
└── scripts/
    └── setup-scrapers.ts   # One-time setup for scraper accounts
```

| Package | Description | Stack |
|---------|-------------|-------|
| `@everycal/core` | Shared types, iCal ↔ ActivityPub conversion | TypeScript |
| `@everycal/server` | HTTP API, auth, SQLite storage, feeds | Hono, better-sqlite3, bcrypt |
| `@everycal/scrapers` | CLI scraper tool with sync support | Cheerio, iCal parsing |
| `@everycal/web` | Web frontend | React 19, Vite, wouter |
| `@everycal/wordpress` | WordPress Gutenberg block plugin | PHP + React |

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 10

## Quick Start

```bash
git clone <repo-url> everycal
cd everycal
pnpm install
```

### 1. Start the server

```bash
pnpm --filter @everycal/server dev
```

Server starts at **http://localhost:3000**. Creates `everycal.db` (SQLite) in the server package directory.

### 2. Start the web frontend

In a second terminal:

```bash
pnpm --filter @everycal/web dev
```

Frontend starts at **http://localhost:5173**. API calls are proxied to the server automatically.

### 3. Create an account

Open http://localhost:5173/register in your browser. Pick a username and password (min 8 characters). You'll be logged in automatically.

### 4. Create an event

Click **+ New Event** in the header. Fill in the form — title and start date are required, everything else is optional. You can set visibility (public/unlisted/followers-only/private), add tags, a location, and a header image (upload or paste a URL).

### 5. Browse

- **/** — upcoming public events
- **/timeline** — events from you and people you follow (requires login)
- **/explore** — find and follow other users
- **/users/yourname** — your profile with all your events

## Setting Up Scrapers

Scrapers import events from external venue websites. Each scraper runs as its own user account on the server.

### Register scraper accounts (one-time)

With the server running:

```bash
# Register accounts and print API keys
npx tsx scripts/setup-scrapers.ts http://localhost:3000

# Register accounts AND immediately scrape + sync all sources
npx tsx scripts/setup-scrapers.ts http://localhost:3000 --run
```

With `--run`, setup + first import is a single command:

```
Setting up scraper accounts on http://localhost:3000

  flex-at             registered → API key: ecal_abc123...
  votivkino           registered → API key: ecal_def456...

--- Running scrapers ---

🔍 Flex Vienna (https://flex.at/events/?ical=1)... 10 events → ✅ 10 created, 0 updated, 0 deleted
🔍 Votiv Kino & De France (https://www.votivkino.at/programm/)... 107 events → ✅ 107 created, 0 updated, 0 deleted

Done!
```

Without `--run`, it prints the CLI commands for running scrapers individually later.

### Run a scraper

```bash
# Sync votivkino events to server
pnpm --filter @everycal/scrapers scrape -- votivkino \
  --sync http://localhost:3000 --api-key ecal_...

# Sync flex events to server
pnpm --filter @everycal/scrapers scrape -- flex-at \
  --sync http://localhost:3000 --api-key ecal_...
```

Each sync run:
- **Creates** new events that weren't on the server before
- **Updates** events that already exist (matched by stable external ID)
- **Deletes** events that the venue has removed from their site

Run scrapers on a cron schedule (e.g. every hour) to keep events current.

### Other scraper commands

```bash
# List available scrapers
pnpm --filter @everycal/scrapers scrape -- --list

# Scrape to stdout (JSON) without syncing
pnpm --filter @everycal/scrapers scrape -- votivkino

# Dry run — show what would be synced
pnpm --filter @everycal/scrapers scrape -- votivkino \
  --sync http://localhost:3000 --api-key ecal_... --dry-run
```

## Available Scrapers

| ID | Source | Method | Events |
|----|--------|--------|--------|
| `flex-at` | [Flex Vienna](https://flex.at/events/) | iCal feed | Concerts, club nights |
| `votivkino` | [Votiv Kino](https://www.votivkino.at/programm/) | HTML scraping | Film screenings |

## API Reference

### Public (no auth required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/events` | List public events |
| `GET` | `/api/v1/events/:id` | Get single event |
| `GET` | `/api/v1/users` | List users (search with `?q=`) |
| `GET` | `/api/v1/users/:username` | User profile |
| `GET` | `/api/v1/users/:username/events` | User's public events |
| `GET` | `/api/v1/users/:username/followers` | User's followers |
| `GET` | `/api/v1/users/:username/following` | Who user follows |
| `GET` | `/api/v1/feeds/:username.json` | JSON feed for an account |
| `GET` | `/api/v1/feeds/:username.ics` | iCal feed for an account |
| `GET` | `/.well-known/webfinger?resource=acct:user@domain` | WebFinger discovery |
| `GET` | `/healthz` | Health check |

Query params for `GET /api/v1/events`: `account`, `from`, `to`, `q` (search), `limit`, `offset`.

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/auth/register` | Create account |
| `POST` | `/api/v1/auth/login` | Log in, get session token |
| `POST` | `/api/v1/auth/logout` | Invalidate session |
| `GET` | `/api/v1/auth/me` | Current user profile |
| `PATCH` | `/api/v1/auth/me` | Update display name, bio, avatar |
| `GET` | `/api/v1/auth/api-keys` | List your API keys |
| `POST` | `/api/v1/auth/api-keys` | Create API key |
| `DELETE` | `/api/v1/auth/api-keys/:id` | Delete API key |

### Authenticated

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/events/timeline` | Events from you + followed users |
| `POST` | `/api/v1/events` | Create event |
| `POST` | `/api/v1/events/sync` | Sync events (for scrapers) |
| `PUT` | `/api/v1/events/:id` | Update event (owner only) |
| `DELETE` | `/api/v1/events/:id` | Delete event (owner only) |
| `POST` | `/api/v1/users/:username/follow` | Follow a user |
| `POST` | `/api/v1/users/:username/unfollow` | Unfollow a user |
| `POST` | `/api/v1/uploads` | Upload an image (10MB max) |

### Authentication methods

All three methods set the user context on the request:

- **Session token**: `Authorization: Bearer <token>` (from login/register)
- **API key**: `Authorization: ApiKey <key>` (from API key management)
- **Cookie**: `everycal_session=<token>` (set automatically by browser)

## Docker

```bash
docker compose up -d
```

This builds and runs just the server at http://localhost:3000. Data is persisted in a Docker volume.

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `/data/everycal.db` | SQLite database path |
| `BASE_URL` | `http://localhost:3000` | Public-facing URL (for federation) |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin for frontend |

## WordPress Plugin

1. Build: `pnpm --filter @everycal/wordpress build`
2. Copy or symlink `packages/wordpress/` into `wp-content/plugins/everycal`
3. Activate in WP Admin → Plugins
4. Add the **EveryCal Feed** Gutenberg block to any page
5. Configure the server URL and optional account filter in block settings

The block server-side renders events from the EveryCal JSON API and caches them using WordPress transients. Three layout options: list, grid, compact.

## Architecture

```
┌─────────────┐     ActivityPub     ┌─────────────┐
│  EveryCal   │◄───────────────────►│  EveryCal   │
│  Server A   │                     │  Server B   │
└──────┬──────┘                     └─────────────┘
       │
       │ JSON/iCal API
       │
┌──────┴──────┐     ┌─────────────┐     ┌─────────────┐
│    Web UI   │     │  Scrapers   │     │  WordPress  │
│  (React)    │     │  CLI        │     │  Plugin     │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │ flex.at     │
                    │ votivkino   │
                    │ (add more)  │
                    └─────────────┘
```

Each scraper is a user account. Events scraped from a venue appear under that account's profile and in its iCal/JSON feed. Users can follow scraper accounts to see venue events in their timeline.

## Development

```bash
# Build everything
pnpm build

# Build specific package
pnpm --filter @everycal/server build
pnpm --filter @everycal/web build

# Dev mode (server + web in parallel)
pnpm dev

# Just the server
pnpm --filter @everycal/server dev

# Just the frontend
pnpm --filter @everycal/web dev
```

### Adding a new scraper

1. Create `packages/scrapers/src/scrapers/your-venue.ts` implementing the `Scraper` interface
2. Register it in `packages/scrapers/src/registry.ts`
3. Each event needs a stable `id` field for sync (e.g. `your-venue-{external-id}`)
4. Run `npx tsx scripts/setup-scrapers.ts` to create its server account

```typescript
import type { Scraper } from "../scraper.js";
import type { EveryCalEvent } from "@everycal/core";

export class YourVenueScraper implements Scraper {
  readonly id = "your-venue";
  readonly name = "Your Venue Name";
  readonly url = "https://your-venue.com/events";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    // Fetch and parse events...
    return events;
  }
}
```

## License

[AGPL-3.0-only](LICENSE)
