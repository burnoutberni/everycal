# EveryCal

A federated event calendar built on [ActivityPub](https://www.w3.org/TR/activitypub/). Self-host a server, import events from venue websites via scrapers, browse them in a dark-mode web UI, and embed feeds in WordPress.

## Why?

- **Self-hosted & federated** — your events, your server, connected to everyone else's via ActivityPub
- **Privacy-first** — public, unlisted, followers-only, or fully private events
- **Scraper framework** — automatically import events from venue websites, each scraper runs as its own account
- **Social features** — follow users, repost events, auto-repost from favorite venues
- **Web frontend** — dark minimal UI with calendar views, event cards, and federation support
- **WordPress integration** — Gutenberg block that pulls events from any EveryCal server
- **Production ready** — rate limiting, security headers, Docker support, non-root containers

## Packages

```
everycal/
├── packages/
│   ├── core/          # Shared types, iCal ↔ ActivityPub conversion
│   ├── server/        # Hono HTTP server + SQLite + ActivityPub federation
│   ├── scrapers/      # CLI tool + venue scrapers (wirmachen.wien collection)
│   ├── web/           # React + Vite frontend (dark theme)
│   └── wordpress/     # WordPress plugin with Gutenberg block
└── scripts/
    ├── setup-scraper-accounts.ts  # Register scraper accounts with API keys
    └── setup-wirmachen-wien.ts    # Setup Vienna venue scraper collection
```

| Package | Description | Stack |
|---------|-------------|-------|
| `@everycal/core` | Shared types, iCal ↔ ActivityPub conversion | TypeScript |
| `@everycal/server` | HTTP API, auth, SQLite storage, ActivityPub federation | Hono, better-sqlite3, bcrypt, http-signature |
| `@everycal/scrapers` | CLI scraper tool with sync support | Cheerio, iCal parsing |
| `@everycal/web` | Web frontend with calendar, reposts, federation | React 19, Vite, wouter |
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

- **/** — your personal feed: upcoming events from you and people/venues you follow (or public events when logged out)
- **/explore** — discover and follow other users
- **/federation** — search and follow remote ActivityPub users from other servers
- **/@username** — user profile with all their events
- **/@username/event-slug** — individual event page with clean URLs

### 6. Social Features

- **Follow users** — see their events in your home feed
- **Repost events** — share individual events to your feed
- **Auto-repost** — automatically repost all public events from a user (great for following venue accounts)
- **Remote follows** — follow users on other ActivityPub servers (Mastodon, Mobilizon, etc.)

## Setting Up Scrapers

Scrapers import events from external venue websites. Each scraper runs as its own user account on the server.

### Quick setup for Vienna venues (wirmachen.wien)

We've created a collection of Vienna community space scrapers. Set them all up at once:

```bash
# Register all wirmachen.wien scrapers and run initial import
npx tsx scripts/setup-wirmachen-wien.ts http://localhost:3000
```

This creates accounts for:
- **westbahnpark** (Westbahnpark community space)
- **kirchberggasse** (Kirchberggasse 3)
- **matznerviertel** (Matznerviertel neighborhood events)
- **space-and-place** (Space and Place)
- **critical-mass-vienna** (Critical Mass bike rides)
- **radlobby-wien** (Radlobby Wien cycling advocacy)

API keys are saved to `scraper-api-keys.json` for use in cron jobs.

### Register scraper accounts manually

For other scrapers or custom setups:

```bash
# Register accounts and print API keys
npx tsx scripts/setup-scraper-accounts.ts http://localhost:3000

# Optionally run immediate import
npx tsx scripts/setup-scraper-accounts.ts http://localhost:3000 --run
```

### Run a scraper

```bash
# Sync a specific scraper to server
pnpm --filter @everycal/scrapers scrape -- westbahnpark \
  --sync http://localhost:3000 --api-key ecal_...

# Run using the saved API keys from setup
pnpm --filter @everycal/scrapers run -- westbahnpark \
  --sync http://localhost:3000

# Run all scrapers in sequence
pnpm --filter @everycal/scrapers run -- --all \
  --sync http://localhost:3000
```

Each sync run:
- **Creates** new events that weren't on the server before
- **Updates** events that have changed (matched by stable external ID or content hash)
- **Deletes** events that the venue has removed from their site

Run scrapers on a cron schedule (e.g. every hour) to keep events current.

### Automated runs with cron

```bash
# Run all scrapers daily at 6am
0 6 * * * cd /path/to/everycal && pnpm --filter @everycal/scrapers run -- --all --sync https://your-domain.com
```

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

### wirmachen.wien Collection (Vienna Community Spaces)

| ID | Source | Method | Events |
|----|--------|--------|--------|
| `westbahnpark` | [Westbahnpark](https://www.westbahnpark.at) | HTML scraping | Community space events |
| `kirchberggasse` | [Kirchberggasse 3](https://www.kirchberggasse.at) | HTML scraping | Cultural events |
| `matznerviertel` | [Matznerviertel](https://matznerviertel.at) | HTML scraping | Neighborhood events |
| `space-and-place` | [Space and Place](https://spaceandplace.at) | HTML scraping | Community events |
| `critical-mass-vienna` | [Critical Mass Vienna](https://criticalmass.wien) | HTML scraping | Monthly bike rides |
| `radlobby-wien` | [Radlobby Wien](https://wien.radlobby.at) | iCal feed | Cycling advocacy events |

All scrapers output events with proper titles, descriptions, dates, locations, and images where available.

## API Reference

### Public (no auth required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/events` | List public events |
| `GET` | `/api/v1/events/:id` | Get single event by ID |
| `GET` | `/@:username/:slug` | Get event by username and slug |
| `GET` | `/api/v1/users` | List users (search with `?q=`) |
| `GET` | `/api/v1/users/:username` | User profile |
| `GET` | `/api/v1/users/:username/events` | User's public events |
| `GET` | `/api/v1/users/:username/followers` | User's followers |
| `GET` | `/api/v1/users/:username/following` | Who user follows |
| `GET` | `/api/v1/feeds/:username.json` | JSON feed for an account |
| `GET` | `/api/v1/feeds/:username.ics` | iCal feed for an account |
| `GET` | `/.well-known/webfinger` | WebFinger discovery for federation |
| `GET` | `/.well-known/nodeinfo` | NodeInfo discovery |
| `GET` | `/nodeinfo/2.1` | Server metadata |
| `GET` | `/users/:username` | ActivityPub actor |
| `POST` | `/users/:username/inbox` | ActivityPub inbox (signed) |
| `GET` | `/users/:username/outbox` | ActivityPub outbox |
| `GET` | `/users/:username/followers` | ActivityPub followers collection |
| `GET` | `/users/:username/following` | ActivityPub following collection |
| `POST` | `/inbox` | Shared inbox (signed) |
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
| `POST` | `/api/v1/events/:id/repost` | Repost event to your feed |
| `DELETE` | `/api/v1/events/:id/repost` | Remove repost |
| `PUT` | `/api/v1/events/:id` | Update event (owner only) |
| `DELETE` | `/api/v1/events/:id` | Delete event (owner only) |
| `POST` | `/api/v1/users/:username/follow` | Follow a user |
| `POST` | `/api/v1/users/:username/unfollow` | Unfollow a user |
| `POST` | `/api/v1/users/:username/auto-repost` | Auto-repost all events from user |
| `DELETE` | `/api/v1/users/:username/auto-repost` | Stop auto-reposting |
| `POST` | `/api/v1/uploads` | Upload an image (5MB max) |

### Federation API (Authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/federation/following` | List remote actors you follow |
| `POST` | `/api/v1/federation/follow` | Follow a remote ActivityPub actor |
| `POST` | `/api/v1/federation/unfollow` | Unfollow a remote actor |
| `POST` | `/api/v1/federation/fetch-actor` | Fetch remote actor info |
| `POST` | `/api/v1/federation/search` | Search for remote actors (WebFinger) |

### Authentication methods

All three methods set the user context on the request:

- **Session token**: `Authorization: Bearer <token>` (from login/register)
- **API key**: `Authorization: ApiKey <key>` (from API key management)
- **Cookie**: `everycal_session=<token>` (set automatically by browser)

## Docker

### Server only

```bash
docker compose up -d
```

This builds and runs the server at http://localhost:3000. Data is persisted in a Docker volume.

### Server + Scrapers (separate containers)

```bash
docker compose -f docker-compose.yml -f docker-compose.scrapers.yml up -d
```

Runs two containers:
- **everycal-server** — API server and web UI
- **everycal-scrapers** — Cron-based scraper runs (every 6 hours)

### Environment variables

Copy `.env.example` to `.env` and customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:3000` | Public-facing URL (for federation) |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `/data/everycal.db` | SQLite database path |
| `UPLOAD_DIR` | `uploads` | Directory for uploaded images |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `TRUSTED_PROXY` | `false` | Set to `true` behind reverse proxy |
| `OPEN_REGISTRATIONS` | `true` | Allow public sign-ups |
| `SKIP_SIGNATURE_VERIFY` | (unset) | Skip ActivityPub signature verification (dev only) |

### Production deployment

The Docker image:
- Runs as non-root user (UID 1001)
- Includes security headers and rate limiting
- Has health check endpoint
- Serves static web UI from `/packages/web/dist`
- Persists data to `/data` volume

Example nginx reverse proxy config:

```nginx
server {
    listen 443 ssl http2;
    server_name events.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `TRUSTED_PROXY=true` when behind nginx/cloudflare so rate limiting uses real client IPs.

## WordPress Plugin

1. Build: `pnpm --filter @everycal/wordpress build`
2. Copy or symlink `packages/wordpress/` into `wp-content/plugins/everycal`
3. Activate in WP Admin → Plugins
4. Add the **EveryCal Feed** Gutenberg block to any page
5. Configure the server URL and optional account filter in block settings

The block server-side renders events from the EveryCal JSON API and caches them using WordPress transients. Three layout options: list, grid, compact.

## Architecture

```
┌─────────────┐     ActivityPub     ┌─────────────┐     ┌─────────────┐
│  EveryCal   │◄───────────────────►│  Mastodon   │     │  Mobilizon  │
│  Server A   │   (HTTP Signature)  │   Server    │     │   Server    │
└──────┬──────┘                     └─────────────┘     └─────────────┘
       │
       │ JSON/iCal API + ActivityPub
       │
┌──────┴──────┐     ┌─────────────┐     ┌─────────────┐
│    Web UI   │     │  Scrapers   │     │  WordPress  │
│  (React)    │     │  CLI/Cron   │     │  Plugin     │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │ wirmachen   │
                    │   .wien     │
                    │ collection  │
                    └─────────────┘
```

### Data model

- **Events** — stored with slugs for clean URLs (`/@username/event-title`)
- **Scrapers as users** — each scraper is a regular user account (marked `is_bot=1`)
- **Reposts** — users can repost events (one-time) or auto-repost all events from an account
- **Local + Remote follows** — follow local users and remote ActivityPub actors
- **Federation** — full ActivityPub support with HTTP signature verification

Each scraper is a user account. Events scraped from a venue appear under that account's profile and in its iCal/JSON feed. Users can follow scraper accounts to see venue events in their timeline, or enable auto-repost to share all their events.

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
4. Run `npx tsx scripts/setup-scraper-accounts.ts` to create its server account

```typescript
import type { Scraper } from "../scraper.js";
import type { EveryCalEvent } from "@everycal/core";
import * as cheerio from "cheerio";

export class YourVenueScraper implements Scraper {
  readonly id = "your-venue";
  readonly name = "Your Venue Name";
  readonly url = "https://your-venue.com/events";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await fetch(this.url);
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const events: Partial<EveryCalEvent>[] = [];
    
    $(".event").each((_, el) => {
      events.push({
        id: `your-venue-${$(el).data("id")}`,
        title: $(el).find(".title").text().trim(),
        startDate: $(el).find(".date").attr("datetime"),
        description: $(el).find(".description").text().trim(),
        location: {
          name: "Your Venue",
          address: "123 Street, City",
        },
        url: new URL($(el).find("a").attr("href")!, this.url).href,
      });
    });
    
    return events;
  }
}
```

For iCal-based scrapers, use the built-in `ICalScraper` base class (see `radlobby-wien.ts` for example).

### Security Features

- **Rate limiting** — protects auth, uploads, federation endpoints, and ActivityPub inboxes
- **Account lockout** — 5 failed login attempts = 15 minute lockout
- **HTTP signatures** — verifies authenticity of incoming ActivityPub activities
- **Content-Security-Policy** — prevents XSS attacks in production
- **Non-root containers** — Docker images run as UID 1001
- **API key prefixes** — fast lookup without exposing full keys in logs
- **Session cleanup** — automatic expiration of old sessions

## License

[AGPL-3.0-only](LICENSE)
