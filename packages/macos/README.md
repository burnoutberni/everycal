# EveryCal for macOS

A native SwiftUI macOS client for EveryCal, designed to cover day-to-day Apple Calendar use cases while staying connected to an EveryCal account.

## Highlights

- Native macOS shell with SwiftUI, multiple windows, toolbar actions, keyboard shortcuts, and system color/material support.
- Account connection against an EveryCal server using the existing `/api/v1/auth/login`, `/api/v1/auth/me`, and `/api/v1/events` endpoints.
- Month, week, day, agenda, and inbox-style calendar views backed by the authenticated EveryCal event feed.
- Event creation, editing, deletion, RSVP, search, tag filters, timezone-aware all-day/timed events, visibility controls, and location/url metadata.
- Offline-first local draft queue for event edits made while the API is unavailable, with a visible sync center.

## Development

```sh
pnpm --filter @everycal/macos build
pnpm --filter @everycal/macos bundle
pnpm --filter @everycal/macos dev
```

The SwiftUI target requires macOS 14 or newer. `build` compiles the release executable and assembles `.build/EveryCal.app`; `dev` launches the app through SwiftPM. On non-macOS hosts the package scripts intentionally no-op so the JavaScript monorepo can still build and test.

## Account setup

The default server is `https://everycal.localhost`, but users can point the app at any EveryCal deployment from the sign-in screen. Authentication is session-cookie based, matching the web client.
