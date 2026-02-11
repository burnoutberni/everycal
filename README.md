# EveryCal

A federated event calendar built on [ActivityPub](https://www.w3.org/TR/activitypub/). Run your own server, federate events with others, and embed feeds anywhere.

## Why?

- **Self-hosted & federated** — your events, your server, connected to everyone else's
- **Privacy-first** — public, unlisted, followers-only, or fully private events
- **WordPress integration** — world-class Gutenberg block that pulls events from any EveryCal server
- **Scraper framework** — automatically import events from venue websites into feeds

## Packages

| Package | Description |
|---------|-------------|
| [`@everycal/core`](packages/core) | Shared types, iCal ↔ ActivityPub conversion |
| [`@everycal/server`](packages/server) | Hono-based HTTP server with SQLite + ActivityPub federation |
| [`@everycal/scrapers`](packages/scrapers) | CLI tool + scrapers for importing events from external sites |
| [`@everycal/wordpress`](packages/wordpress) | WordPress plugin with Gutenberg block for displaying feeds |

## Quick Start

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 10

### Development

```bash
pnpm install
pnpm dev          # starts server + scraper watch mode in parallel
```

### Docker

```bash
docker compose up -d
```

The server will be available at `http://localhost:3000`.

### Run scrapers

```bash
# List available scrapers
pnpm --filter @everycal/scrapers scrape -- --list

# Scrape all sources, print JSON
pnpm --filter @everycal/scrapers scrape

# Scrape a specific source
pnpm --filter @everycal/scrapers scrape -- flex-at

# Scrape and push to a running server
pnpm --filter @everycal/scrapers scrape -- flex-at --push http://localhost:3000
```

### WordPress Plugin

1. Build: `pnpm --filter @everycal/wordpress build`
2. Copy/symlink the `packages/wordpress` directory into your WP `wp-content/plugins/` as `everycal`
3. Activate in WP Admin → Plugins
4. Add the **EveryCal Feed** block to any page
5. Configure the server URL and optional account filter in the block settings

## API

### Public endpoints (no auth)

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/events?account=&from=&to=&limit=` | List public events |
| `GET /api/v1/events/:id` | Single event |
| `GET /api/v1/feeds/:username.json` | JSON feed for an account |
| `GET /api/v1/feeds/:username.ics` | iCal feed for an account |
| `GET /.well-known/webfinger?resource=acct:user@domain` | WebFinger discovery |
| `GET /healthz` | Health check |

## Available Scrapers

| ID | Source | Type |
|----|--------|------|
| `flex-at` | [Flex Vienna](https://flex.at/events/) | Concert venue (iCal feed) |
| `votivkino` | [Votiv Kino](https://www.votivkino.at/programm/) | Cinema (HTML scraping) |

## Architecture

```
┌─────────────┐     ActivityPub     ┌─────────────┐
│  EveryCal   │◄──────────────────►│  EveryCal   │
│  Server A   │                     │  Server B   │
└──────┬──────┘                     └─────────────┘
       │ JSON API
       │
┌──────┴──────┐     ┌─────────────┐
│  WordPress  │     │  Scrapers   │──► flex.at
│  Plugin     │     │  CLI        │──► votivkino.at
└─────────────┘     └─────────────┘
```

## License

[AGPL-3.0-only](LICENSE)
