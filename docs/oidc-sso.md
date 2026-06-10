# OIDC SSO for EveryCal

EveryCal supports optional single-organization OpenID Connect (OIDC) SSO using the Authorization Code Flow with PKCE. Local username/password auth remains enabled by default, and OIDC is disabled by default.

## Required configuration

Set these environment variables:

- `OIDC_ENABLED=true`
- `OIDC_ISSUER_URL` — the provider issuer/discovery URL
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `BASE_URL` — the public EveryCal URL

Optional fields include `OIDC_PROVIDER_KEY` (defaults to `primary_oidc`), `OIDC_REDIRECT_URI` (defaults to `${BASE_URL}/api/v1/auth/oidc/callback`), `OIDC_SCOPES` (defaults to `openid profile email`), and `OIDC_POST_LOGOUT_REDIRECT_URI`.

Example:

```text
OIDC_SCOPES="openid profile email"
```

## Authentik setup notes

Create an Authentik OAuth2/OIDC provider/application and register this redirect URI:

```text
https://your-everycal.example/api/v1/auth/oidc/callback
```

Use Authentik's issuer URL as `OIDC_ISSUER_URL`, then copy the client ID and secret into EveryCal. Keep the scope set to include `openid`, `profile`, and `email`.

## Account linking and provisioning

On first successful SSO login, EveryCal uses the provider `iss` and `sub` claims as the durable external identity key. If no external identity link exists, EveryCal will auto-link to an existing local account only when the provider returns a verified email claim matching that account. Unverified or missing email claims are rejected for linking and provisioning.

If no matching local account exists, EveryCal creates one only when `OIDC_JIT_PROVISIONING=true`. JIT users receive normal local account rows, default notification preferences, `auth_source='oidc'`, and a linked row in `account_auth_identities`.

## Claim sync, admin sync, and roles

`OIDC_SYNC_CLAIMS_ON_LOGIN=true` mirrors safe profile fields such as display name and avatar on login. `OIDC_SYNC_ADMIN=false` and `OIDC_SYNC_ROLES=false` by default.

When admin sync is enabled, the configured admin claim updates `accounts.is_admin`, which remains the enforcement field for admin authorization. Setting `accounts.sso_admin_locked=1` protects a local admin from accidental SSO-driven admin removal. Role/group values can be mirrored into `account_role_assignments` with `source='oidc'` for future RBAC without replacing the current `is_admin` checks.

## Logout caveat

EveryCal always clears the local session on logout. If the provider advertises or supports an end-session endpoint, EveryCal returns a provider logout URL and the web UI redirects there. EveryCal does not store ID tokens for v1, so providers that require `id_token_hint` for RP-initiated logout may need provider configuration that allows logout without it or may fall back to local-only logout.

## Disabling local password auth

Set `DISABLE_LOCAL_PASSWORD_AUTH=true` to block local password login, registration, password reset, and password change endpoints with a stable `local_auth_disabled` error. Existing cookie sessions and API keys are not revoked by this setting.
