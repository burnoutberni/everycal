# EveryCal

Federated event calendar built on [ActivityPub](https://www.w3.org/TR/activitypub/).

EveryCal now supports **three deployment targets**:

1. **Direct Node.js** (existing, unchanged default)
2. **Docker Compose** (existing, unchanged)
3. **Cloudflare-native Phase 3** (optional target: Pages + Workers + D1 + R2 + Cron + Queues)

---

## Monorepo layout

- `packages/server` - existing Hono API + SSR entry + SQLite + ActivityPub federation
- `packages/web` - React + Vike frontend
- `packages/core` - shared types/utilities + storage interfaces
- `packages/jobs` - scheduled scraper/reminder jobs (Node/Docker path)
- `packages/cloudflare-worker` - Cloudflare Worker thin platform layer
- `packages/runtime-core` - shared runtime-agnostic API app used by Worker and Node unified mode

---

## Deployment Path 1: Direct Node.js (unchanged)

```bash
pnpm install
pnpm dev
```

Production:

```bash
pnpm build
pnpm --filter @everycal/server start
```

---

## Deployment Path 2: Docker (unchanged)

```bash
docker compose up -d --build
```

Container behavior remains unchanged:

- Non-root runtime user
- API + SSR served from one process
- Optional in-process jobs via `RUN_JOBS_INTERNALLY=true`

---

## Deployment Path 3: Cloudflare-native (optional MVP)

### What this target uses

- **Cloudflare Pages** for frontend hosting (`packages/web`)
- **Workers** for API + federation endpoints
- **D1** for core relational data (accounts/sessions/events/upload metadata)
- **R2** for upload object storage
- **Cron Trigger** via Worker `scheduled()` handler for session cleanup
- **Queues** producer/consumer bindings for job migration

### Frontend deployment (Pages)

```bash
pnpm cf:pages:build
pnpm cf:pages:deploy
```

Cloudflare Pages Functions proxy API/federation paths (`/api/*`, `/.well-known/*`, `/users/*`, `/events/*`, `/nodeinfo/*`, `/inbox`) to your Worker API origin, so the frontend can live on Pages while backend stays on Workers.


### One-click deploy

Use Cloudflare's Deploy button (replace repo URL if self-hosting your own fork):


> **Important:** the Deploy button provisions app code, but production parity with Docker still requires post-deploy configuration (D1/R2 IDs, Worker secrets, Pages API origin, and reminder/scraper executors).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/everycal/everycal)

### Beginner quickstart (copy/paste)

```bash
pnpm install
pnpm cf:migrate
pnpm cf:dev
# optional readiness checks (warn-only/local and strict)
pnpm cf:check
pnpm cf:check:strict
# then deploy
pnpm cf:deploy
pnpm cf:pages:build
pnpm cf:pages:dev
pnpm cf:pages:deploy
pnpm --filter @everycal/server dev:unified
```

### Required setup before first deploy

1. Create a D1 database in Cloudflare dashboard.
2. Create an R2 bucket for uploads.
3. Update `wrangler.toml` with your `database_id`, bucket name, and `BASE_URL`.

---

## Cloudflare compatibility matrix (Phase 3)

### Unified backend rewrite status

- New shared app package: `packages/runtime-core` (`createUnifiedApp`)
- Cloudflare Worker now runs as a thin adapter over shared runtime-core.
- Node/Docker default runtime is still the existing server entrypoint (`packages/server/src/index.ts`); unified Node mode is opt-in for migration testing (`pnpm --filter @everycal/server dev:unified`).


| Capability | Direct Node | Docker | Cloudflare |
|---|---:|---:|---:|
| Health endpoint | ✅ | ✅ | ✅ |
| Session bootstrap/auth session cookie | ✅ | ✅ | ✅ |
| Register/login/logout/me | ✅ | ✅ | ✅ |
| Event create + own list + public list | ✅ | ✅ | ✅ |
| Identities (create/list basic) | ✅ | ✅ | ✅ |
| Saved locations API | ✅ | ✅ | ✅ |
| API followers/following lists | ✅ | ✅ | ✅ (basic) |
| iCal + JSON feed endpoint | ✅ | ✅ | ✅ |
| Upload binary storage | local FS | mounted volume | R2 |
| Upload metadata persistence | SQLite | SQLite | D1 |
| Basic federation endpoints + federation cache list APIs | ✅ | ✅ | ✅ (basic) |
| Frontend hosting on Cloudflare | n/a | n/a | ✅ Pages |
| Full SSR web app rendering parity | ✅ | ✅ | ✅ |
| Full ActivityPub federation parity | ✅ | ✅ | ⚠️ requires Worker secret/config wiring |
| Reminder/scraper execution parity | in-process/CLI | in-process | ⚠️ requires connected reminder/scraper executors |

Cloudflare target is intentionally additive and does **not** modify existing Node/Docker runtime behavior.

### Remaining cross-platform workpackages to reach full parity

1. **Cloudflare post-deploy secret/resource wiring**
   - Set required Worker secrets/env for federation and jobs (for example `ACTIVITYPUB_PRIVATE_KEY_PEM`, job auth token/URLs as used by your deployment model).
   - Ensure D1/R2/KV/Durable Object bindings and Pages `API_ORIGIN` are all configured with real values.
2. **Reminder/scraper executor wiring**
   - Docker runs jobs in-process/CLI; Cloudflare requires connected executors (native service bindings or webhook-backed workers) to achieve equivalent behavior.
3. **Operational parity hardening**
   - Add production monitoring/alerts and rollback playbooks specific to Cloudflare resources and queue/cron paths.
4. **Continuous parity regression gates**
   - Keep cross-runtime contract and federation integration tests in CI and expand as new features ship.

### One-click-ish bootstrap (Phases A-C)

A new bootstrap orchestrator is available to minimize required input to essentially a domain (and a Cloudflare API token/account context):

```bash
# plan only (no API calls)
pnpm cf:bootstrap -- --domain calendar.example.com

# apply: provision resources + generate config + set secrets + deploy (OAuth via wrangler)
wrangler login
pnpm cf:bootstrap -- --domain calendar.example.com --apply --smtp-host smtp.example.com --smtp-port 587 --smtp-from no-reply@example.com

# optional fallback: API token mode
export CLOUDFLARE_API_TOKEN=...
pnpm cf:bootstrap -- --domain calendar.example.com --apply --auth api-token --smtp-host smtp.example.com --smtp-port 587 --smtp-from no-reply@example.com

# apply mode now deploys by default; use --no-deploy to generate/provision only
pnpm cf:bootstrap -- --domain calendar.example.com --apply --no-deploy
```

What it does:
- **Phase A (provisioning orchestration):** creates/ensures D1, KV, R2, and Queue resources via Wrangler OAuth by default (or API token fallback) and writes generated configs under `.generated/`.
  - Queue provisioning is idempotent across reruns; if queue name already exists from a prior partial run, bootstrap reuses it.
- **Phase B (convention defaults):** derives `BASE_URL`, `CORS_ORIGIN`, `API_ORIGIN`, and resource names from the domain + env convention.
- **Phase C (first-run bootstrap artifacts):** reuses existing generated federation key/job token by default (generate-once behavior), rotates only when explicitly requested via `--rotate-keys`, and sets Worker secrets.
- **Service-binding mode (Cloudflare-native):** generates and deploys companion reminder/scraper workers (`everycal-reminders-*`, `everycal-scrapers-*`) and binds them automatically. Companions forward to configured executor webhook targets and expose `/healthz` for behavioral readiness checks.

Common flags:
- `--pages-project <name>` to customize Pages project name (default `everycal-web`).
- `--account-id <id>` to pin a specific Cloudflare account.
- `--auth oauth|api-token` authentication mode (default `oauth` via `wrangler login`).
- `--rotate-keys` to force regeneration of federation/job secrets.
- `--reminders-webhook-url` / `--scrapers-webhook-url` to configure companion worker executor targets (recommended for behavioral parity checks).
- `--smtp-host`, `--smtp-port`, `--smtp-from` (plus optional `--smtp-secure`, `--smtp-user`, `--smtp-pass`) to supply and validate production SMTP during bootstrap.
- when `--smtp-pass` is omitted in interactive TTY mode, bootstrap prompts for SMTP password.
- `--allow-no-smtp` only for non-production/testing; production bootstrap enforces SMTP by default.
- `--allow-no-r2` to continue provisioning when R2 is not enabled on the Cloudflare account (uploads will be unavailable until R2 is enabled and bootstrap re-run).
- DNS checkpoint: apply+deploy pauses and prints required DNS records, then resumes after you type `done`.
  - bootstrap attempts to detect your Workers subdomain automatically (Cloudflare API first, then `wrangler whoami`); if unavailable, run `wrangler whoami`.
  - if `wrangler whoami` doesn't show a workers.dev subdomain, create one in Cloudflare Dashboard → Workers & Pages → Overview.
- `--auto-confirm-dns` to skip the DNS confirmation pause in automation; `--skip-dns-checkpoint` to disable DNS checkpoint entirely.
- `--write-tracked-configs` to overwrite repo-tracked `wrangler.toml` and `packages/web/wrangler.toml` from generated production configs.
- `--no-deploy`, `--skip-secrets`, `--skip-companion-workers`, `--skip-config-check`, `--skip-remote-verify` for advanced flows.

### Production source of truth: generated config

For production, generated config under `.generated/` is the default source of truth.
Use:

```bash
pnpm cf:migrate:prod
pnpm cf:deploy:prod
pnpm cf:pages:deploy:prod
```

This avoids placeholder drift in repo-tracked template wrangler files.

### Strict go-live gates

Run a strict gate before cutover:

```bash
pnpm cf:go-live-gate -- --api-origin https://api.calendar.example.com
```

This enforces:
- generated config strict validation,
- SMTP validated in bootstrap receipt,
- runtime readiness success (including behavioral executor checks), and
- smoke checks (`/healthz`, `/api/v1/bootstrap`).

### Deploy readiness validation

- API readiness endpoint (Worker): `GET /api/v1/system/deploy-readiness`
  - Returns `200` when required federation/jobs/baseline runtime wiring is present.
  - Returns `503` with failing checks when required wiring is missing.
- Local config checker: `pnpm cf:check` (warn-only) and `pnpm cf:check:strict` (fail-fast).
  - Validates common placeholder mistakes in `wrangler.toml` and `packages/web/wrangler.toml` before production deploy.


---

## Troubleshooting + free-tier notes

- D1 free tier has query/size limits; keep scraper volume conservative.
- R2 free egress/ops limits apply; optimize image size before upload.
- If `pnpm cf:dev` fails with missing auth, run `wrangler login`.
- If migrations fail, verify `database_id` and binding name `DB` in `wrangler.toml`.

---

## Rollback/safety notes

- To rollback Cloudflare target, disable Worker routes and keep Node/Docker deployment running as-is.
- No existing `packages/server` startup path or Docker compose command was replaced.
- Cloudflare schema is isolated in `packages/cloudflare-worker/migrations`; it does not mutate local SQLite files.

---

## Useful commands

```bash
pnpm lint
pnpm test
pnpm cf:dev
pnpm cf:migrate
pnpm cf:deploy
pnpm cf:pages:build
pnpm cf:pages:dev
pnpm cf:pages:deploy
pnpm --filter @everycal/server dev:unified
```

## Timezone interoperability notes

- **ActivityPub outbound**: EveryCal emits `Event.startTime` / `Event.endTime` as absolute UTC (`...Z`) for compatibility.
- **ActivityPub timezone extension**: when known, EveryCal includes `eventTimezone` with an inline EveryCal JSON-LD context mapping.
- **ActivityPub inbound fallback**: if no IANA timezone is provided, EveryCal stores UTC instants when derivable (for `Z`/offset input) and marks timezone precision as unknown or offset-only.
- **iCalendar import/export**: feeds now support `TZID`, generated `VTIMEZONE`, UTC fallback output, and RFC5545 all-day `VALUE=DATE` with end-exclusive `DTEND`.

## License

[AGPL-3.0-only](LICENSE)
