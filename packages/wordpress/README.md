# EveryCal WordPress Plugin

WordPress plugin for embedding federated EveryCal event feeds with a server-rendered Gutenberg block.

## Requirements

- WordPress `>= 6.4`
- PHP `>= 7.4`

## What it does

- Registers one block: `everycal/feed` (`EveryCal Feed` in the editor)
- Fetches public events from an EveryCal instance
- Supports list, grid, and compact layouts
- Supports optional per-block account filtering
- Caches feed and event payloads for resilience and performance
- Can render event detail pages on your WP site via rewrite rules

## Installation

### From a built zip

1. Build the plugin zip:

```bash
pnpm --filter @everycal/wordpress build
pnpm --filter @everycal/wordpress plugin-zip
```

2. Upload zip in WordPress: **Plugins -> Add New -> Upload Plugin**.
3. Activate **EveryCal**.

### Local plugin folder

1. Copy/symlink `packages/wordpress` into `wp-content/plugins/everycal`.
2. Build assets:

```bash
pnpm --filter @everycal/wordpress build
```

3. Activate **EveryCal** in wp-admin.

## Development checks

Run these from the repository root:

```bash
pnpm --filter @everycal/wordpress build
pnpm --filter @everycal/wordpress lint
pnpm --filter @everycal/wordpress test
pnpm --filter @everycal/wordpress php:setup
pnpm --filter @everycal/wordpress lint:php:strict
```

What each command does:

- `build`: compiles block assets into `packages/wordpress/build`
- `lint`: runs JavaScript and PHP syntax checks
- `test`: runs plugin unit tests (Jest via `@wordpress/scripts`)
- `php:setup`: installs Composer-based PHP tooling in `packages/wordpress/vendor`
- `lint:php:strict`: runs PHPCS (WPCS) and PHPStan

## Quick start

1. Open **Settings -> EveryCal**.
2. Set **Default EveryCal server URL** (example: `https://events.example.com`).
3. Edit a page/post and insert the **EveryCal Feed** block.
4. Optionally set **Account** to filter one username.

## Configuration

Plugin settings are in **Settings -> EveryCal**.

- `everycal_default_server_url`: default server URL used for new blocks and empty block fallback
- `everycal_cache_ttl_minutes`: feed/event cache freshness window (`1..10080`, default `1440`)
- `everycal_prewarm_past_hours`: how long ended events stay prewarmed (`0..8760`, default `24`)
- `everycal_base_path`: event detail page base path (default `events`, empty values fall back to `events`)
- `everycal_creator_url_template`: optional creator profile URL template
- `everycal_http_debug_manual`: force HTTP debug logging when `WP_DEBUG` is off
- `everycal_http_debug_additional_servers`: extra hosts to include in debug logs

Creator URL template tokens:

- `{username}`
- `{domain}`
- `{handle}`
- `{server_url}`

## Block attributes

- `serverUrl` (`string`): server override for this block
- `account` (`string`): optional account username
- `limit` (`number`): events per page (`1..50` in editor)
- `layout` (`list | grid | compact`)
- `gridColumns` (`number`): only used by grid layout (`1..6`)
- `descriptionLengthMode` (`full | words | chars`)
- `descriptionWordCount` (`number`): used when mode is `words`
- `descriptionCharCount` (`number`): used when mode is `chars`

## Caching behavior

- Feed data uses a two-tier cache:
  - Store cache with payloads
  - Freshness flag that controls when to re-fetch
- On upstream request failures, stale data is served when available.
- Single-event payloads are prewarmed from feed responses for faster event pages.

## Rewrite routes and event pages

When event pages are enabled via the base path setting, events resolve under:

- `/{base-path}/@username/event-slug`

If the saved base path is empty (for example after trimming `/` and spaces), the plugin automatically falls back to `events`.

Rewrite rules are flushed when `everycal_base_path` changes.

## Extensibility hooks

The plugin currently exposes these filters:

- `everycal_http_debug_enabled`
- `everycal_http_debug_error_log_enabled`
- `everycal_creator_url`

See `packages/wordpress/docs/HOOKS.md` for signatures and examples.

## Troubleshooting

- **No events found**: validate the server URL and confirm the upstream feed is public and non-empty.
- **404 on event pages**: save settings (or permalinks) to refresh rewrites.
- **No HTTP logs**: enable `WP_DEBUG` or the manual HTTP debug setting.
- **Custom server missing in debug logs**: add it to Additional HTTP debug servers.

## Security and privacy

- Plugin fetches public event JSON from configured EveryCal servers.
- It does not create front-end tracking cookies.
- Optional debug logs are stored in WordPress options and can be cleared by admins.

## Changelog

See `packages/wordpress/CHANGELOG.md`.

## Support

- Repository: `https://github.com/burnoutberni/everycal`
- Issue tracker: `https://github.com/burnoutberni/everycal/issues`
