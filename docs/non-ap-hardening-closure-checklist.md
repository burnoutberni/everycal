# Non-ActivityPub API hardening completion checklist

- **1) Token hardening completion** — **done in this run**: removed plaintext fallback lookup from calendar feed token resolver; runtime lookup now uses signed tokens or hashed token lookup only. (`packages/server/src/routes/private-feeds.ts`)
- **2) Schema guardrails / hashing expectations** — **done in this run**: expanded token hashing tests to enforce hash-only lookup semantics and 64-hex storage expectations for token secrets. (`packages/server/tests/token-secrets.test.ts`)
- **3) Maintainability decomposition for oversized route modules** — **intentionally deferred**: no safe, reviewable multi-file extraction was completed in this pass without risking endpoint regressions; defer to a dedicated refactor PR with behavior-lock tests first. (`packages/server/src/routes/auth.ts`, `packages/server/src/routes/events.ts`)
- **4) Pagination consistency (non-AP)** — **done in this run**: replaced manual `limit`/`offset` parsing with shared pagination utility handling in users and directory routes. (`packages/server/src/routes/users.ts`, `packages/server/src/routes/directory.ts`)
- **5) Duplication cleanup (easy wins)** — **already satisfied** in the touched token lookup path and pagination parsing path by reusing shared helpers (`findByTokenHash`, `parseLimitOffset`) instead of bespoke parsing/lookup. (`packages/server/src/routes/private-feeds.ts`, `packages/server/src/routes/users.ts`, `packages/server/src/routes/directory.ts`)
- **6) Regression test for legacy plaintext calendar feed tokens** — **done in this run**: added explicit test for plaintext token row rejection and signed token acceptance. (`packages/server/tests/feeds-cors.test.ts`)
- **7) Prompt closure artifact** — **done in this run**: this checklist file.
- **8) Deployment and migration playbook note** — **done in this run**: operator note added with deploy/rollback guidance for hash-only lookup behavior. (`docs/non-ap-hardening-deploy-playbook.md`)
- **9) Lightweight performance sanity checks** — **done in this run**: targeted auth/events/private-feed adjacent test runs executed and summarized in implementation report output.
