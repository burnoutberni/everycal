# Non-ActivityPub hardening deploy/migration playbook

## Recommended deploy order
1. Deploy server build containing hash-only calendar feed token lookup + pagination parser consolidation.
2. Run/confirm targeted test suites in CI before full rollout.
3. Roll out gradually (canary/one-instance first) and observe private feed 401/200 ratios.

## One-time migration/runtime expectations
- Signed calendar feed tokens (`ecal_cal_...`) continue to authenticate.
- Existing migrated hashed `calendar_feed_tokens.token` rows continue to authenticate via hash lookup.
- Legacy plaintext token rows no longer authenticate after this deploy.

## Rollback implications
- Rolling back to a build with plaintext fallback would re-accept legacy plaintext token rows (security regression).
- No schema migration is required in this run, so rollback is code-only.
- If rollback is unavoidable, rotate affected calendar feed tokens after re-upgrade to re-establish hash-only behavior.
