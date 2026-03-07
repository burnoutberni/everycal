# Deployment Guide

EveryCal supports three deployment strategies.

## 1) Direct Node.js

```bash
pnpm install
pnpm dev
```

Production:

```bash
pnpm build
pnpm --filter @everycal/server start
```

## 2) Docker Compose

```bash
docker compose up -d --build
curl -fsS http://localhost:3000/healthz
```

Jobs stay in-process as before (`RUN_JOBS_INTERNALLY=true`).

## 3) Cloudflare-native (Phase 3: Pages + Workers)

### Provision resources

1. Create D1 database (`everycal`)
2. Create R2 bucket (`everycal-uploads`)
3. Update `wrangler.toml`

### API Worker commands

```bash
pnpm cf:migrate
pnpm cf:dev
pnpm cf:deploy
```

### Frontend (Cloudflare Pages) commands

```bash
pnpm cf:pages:build
pnpm cf:pages:dev
pnpm cf:pages:deploy
```

Pages Functions in `packages/web/functions` proxy API/federation paths to your Worker (`API_ORIGIN`). This keeps frontend and backend deploys separate while preserving same-origin browser behavior at the Pages domain.

### Cron and queues

- Session cleanup runs in Worker `scheduled()` hourly cron trigger.
- Queue producer/consumer bindings are configured for migrating reminders/scrapers jobs.
- Queue consumer supports native service-binding dispatch for `reminders` and `scrapers` (`REMINDERS_SERVICE`, `SCRAPERS_SERVICE`) with webhook fallback (`REMINDERS_WEBHOOK_URL`, `SCRAPERS_WEBHOOK_URL`).
- Queue consumer now applies bounded retries and optional dead-letter forwarding (`JOBS_DLQ`).

## Compatibility matrix

| Feature | Node | Docker | Cloudflare |
|---|---:|---:|---:|
| Auth/session bootstrap + register/login/logout/me | ✅ | ✅ | ✅ |
| Events (create + own list + public) + iCal/JSON feed | ✅ | ✅ | ✅ |
| Identities (create/list basic) | ✅ | ✅ | ✅ |
| Saved locations API | ✅ | ✅ | ✅ |
| API followers/following lists | ✅ | ✅ | ✅ (basic) |
| Upload storage | FS | Volume | R2 |
| Upload metadata | SQLite | SQLite | D1 |
| Basic federation endpoints + federation cache list APIs | ✅ | ✅ | ✅ |
| Full SSR parity | ✅ | ✅ | ✅ (baseline, no edge-cache yet) |
| Full federation parity (signature delivery, remote fetch cache) | ✅ | ✅ | ⚠️ requires key/secret setup |
| Reminder/scraper parity | ✅ | ✅ | ⚠️ requires connected executors |

## Safety/rollback

Cloudflare deployment is additive only. Existing Node/Docker commands and runtime paths remain unchanged.


## Unified backend rewrite status

- Shared runtime-agnostic server core now lives in `packages/runtime-core`.
- Cloudflare Worker runs as a thin platform adapter over this shared app.
- Node/Docker default server path is still the existing server (`packages/server/src/index.ts`) to avoid regressions.
- Optional Node unified entrypoint is available at `packages/server/src/unified-index.ts` for migration testing.

## Remaining parity gaps

- Existing default Node/Docker server behavior remains unchanged by default.

- Cloudflare SSR now renders via Worker + Vike for HTML routes and includes edge-cache guardrails (toggle/bypass header/tag version) for safe rollouts.
- Full middleware parity includes strong distributed consistency via Durable Object-backed global rate-limit enforcement (with KV/local fallback modes).
- Cloudflare federation parity depends on required secret/key configuration (`ACTIVITYPUB_PRIVATE_KEY_PEM` and related runtime values).
- Cloudflare reminder/scraper parity depends on connected executors (service bindings or webhook targets) with equivalent operational semantics.



## Live test walkthrough for one-click-ish flow

## Ops hardening playbook (production)

Before every production cutover:
- run `pnpm cf:go-live-gate -- --api-origin <origin>` and require pass.
- verify queues are draining and no DLQ growth after bootstrap/deploy window.
- verify cron trigger execution and reminder/scraper companion `/healthz` checks.
- verify federation delivery success rate and signature error rate for newly deployed key material.
- verify alerting channels + rollback command runbook are ready.

Rollback minimum:
- redeploy previous known-good worker artifact/config,
- restore previous companion worker targets if changed,
- if `--rotate-keys` was used unintentionally, restore prior federation private key secret.


1. **Plan the derived config from a single domain input**

```bash
pnpm cf:bootstrap -- --domain calendar.example.com
```

2. **Apply bootstrap provisioning (Wrangler OAuth by default)**

```bash
wrangler login
pnpm cf:bootstrap -- --domain calendar.example.com --apply --smtp-host smtp.example.com --smtp-port 587 --smtp-from no-reply@example.com
```

Optional fallback when OAuth is not viable in your environment:

```bash
export CLOUDFLARE_API_TOKEN=...
pnpm cf:bootstrap -- --domain calendar.example.com --apply --auth api-token --smtp-host smtp.example.com --smtp-port 587 --smtp-from no-reply@example.com
```

If your Cloudflare account has not enabled R2 yet, you can continue bootstrap with:

```bash
pnpm cf:bootstrap -- --domain calendar.example.com --apply --allow-no-r2 --smtp-host smtp.example.com --smtp-port 587 --smtp-from no-reply@example.com
```

This skips the `UPLOADS` binding temporarily; upload features remain unavailable until R2 is enabled and bootstrap is re-run without `--allow-no-r2`.

This now performs provisioning + generated-config strict validation + Worker secret setup by default, and writes:
- `.generated/wrangler.prod.toml`
- `.generated/packages.web.wrangler.prod.toml`
- `.generated/activitypub-private-key.prod.pem`
- `.generated/jobs-webhook-token.prod.txt`
- `.generated/cf-bootstrap-receipt.prod.json`

Key behavior:
- federation/job secrets are **generate-once + reuse** by default across reruns
- pass `--rotate-keys` to explicitly regenerate key/token material
- companion reminder/scraper service workers are generated for Cloudflare-native service bindings and expose `/healthz` for behavioral readiness checks

3. **Deploy + verify readiness (single command)**

```bash
pnpm cf:bootstrap -- --domain calendar.example.com --apply --deploy --reminders-webhook-url https://jobs.example/reminders --scrapers-webhook-url https://jobs.example/scrapers --smtp-host smtp.example.com --smtp-port 587 --smtp-from no-reply@example.com --smtp-secure false --smtp-user smtp-user --smtp-pass smtp-pass
```

This runs companion worker deploys, migrations, EveryCal Worker deploy, Pages build/deploy, and then verifies:

```bash
curl -fsS https://api.calendar.example.com/api/v1/system/deploy-readiness
```

You should see `{ "ok": true, ... }` when all required wiring is present.

For production parity, configure companion executor targets using:
- `--reminders-webhook-url <url>`
- `--scrapers-webhook-url <url>`

Without these, service bindings still deploy, but behavioral readiness checks for companion execution can fail by design.


4. **Run strict go-live gate (required for production cutover)**

```bash
pnpm cf:go-live-gate -- --api-origin https://api.calendar.example.com
```

This enforces generated-config strictness, SMTP validation status from bootstrap receipt, behavioral readiness checks, and smoke checks (`/healthz`, `/api/v1/bootstrap`).

5. **Use generated config as production source of truth**

```bash
pnpm cf:migrate:prod
pnpm cf:deploy:prod
pnpm cf:pages:deploy:prod
```

Repo-tracked wrangler files remain templates; production deploy should come from `.generated/` outputs.

## Current migration chunk status

- ✅ Unified federation cache listing APIs (`/api/v1/federation/actors`, `/api/v1/federation/remote-events`)
- ✅ Unified federation follow/search basics (`/api/v1/federation/search`, `/api/v1/federation/follow`, `/api/v1/federation/unfollow`, `/api/v1/federation/following`)
- ✅ Shared adapter support for D1 and SQLite (`remote_actors`, `remote_events`, `remote_following`)
- ✅ Unified ActivityPub followers/following collections include local + remote relationships
- ✅ Unified runtime shared-inbox verification hook + signed delivery hooks + remote sync endpoint (`/api/v1/federation/sync`)
- ✅ Shared inbox verification now enforces keyId actor matching + required signature headers
- ✅ Cloudflare federation sync now supports remote event lifecycle handling (delete/prune on complete traversal)
- ✅ Cloudflare remote sync now walks paginated outbox pages with idempotent upserts
- ✅ Cloudflare cron now enqueues reminder/scraper queue jobs (`scheduled()` -> `JOBS_QUEUE`)
- ✅ Cloudflare queue consumer now prefers native reminder/scraper service bindings with webhook fallback + retry/DLQ controls
- ✅ Cloudflare queue execution now includes delivery-attempt semantics + job metadata propagation (`attempts`, `jobId`, `enqueuedAt`)
- ✅ Cloudflare Worker applies baseline security headers on SSR/API responses
- ✅ Cloudflare Worker now mirrors API CORS handling + request body size limits
- ✅ Cloudflare Worker now mirrors Node-style route-level rate-limit policy for auth/federation/events/uploads/inbox paths
- ✅ Cloudflare Worker supports optional KV-backed distributed/global rate-limit counters (`RATE_LIMITS_KV`)
- ✅ Cloudflare Worker supports strongly-consistent Durable Object global rate limiting (`RATE_LIMITS_DO`)
- ✅ Cloudflare SSR now emits configurable CDN cache hints (`SSR_CACHE_MAX_AGE_SECONDS`, `SSR_CACHE_STALE_WHILE_REVALIDATE_SECONDS`)
- ✅ Cloudflare SSR rollout guardrails added (`SSR_EDGE_CACHE_ENABLED`, `SSR_EDGE_CACHE_BYPASS_HEADER`, `SSR_CACHE_TAG_VERSION`)
- ✅ Cross-runtime parity CI gate is defined (`.github/workflows/parity-gates.yml`)
- ✅ Cloudflare deploy readiness endpoint is available at `/api/v1/system/deploy-readiness`
- ✅ Cloudflare config readiness checker is available (`pnpm cf:check`, `pnpm cf:check:strict`)

Next chunk:
- Operational hardening and deploy runbook automation (alerts, rollback drills, SLO dashboards).
