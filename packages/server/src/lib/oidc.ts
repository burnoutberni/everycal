import crypto from "node:crypto";
import { nanoid } from "nanoid";
import * as client from "openid-client";
import type { DB } from "../db.js";
import { getBaseUrl } from "./base-url.js";
import { hashTokenSecret } from "./token-secrets.js";
import { normalizeHandle, isValidRegistrationUsername } from "./handles.js";
import { SYSTEM_DATE_TIME_LOCALE, SYSTEM_THEME_PREFERENCE, SYSTEM_TIMEZONE } from "../routes/auth/constants.js";

export type OidcProviderConfig = {
  enabled: boolean;
  providerKey: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  postLogoutRedirectUri: string | null;
  jitProvisioning: boolean;
  syncClaimsOnLogin: boolean;
  syncAdmin: boolean;
  syncRoles: boolean;
  claims: {
    email: string;
    emailVerified: string;
    name: string;
    username: string;
    avatar: string;
    admin: string;
    roles: string;
  };
};

export type OidcClaims = Record<string, unknown> & { iss?: string; sub?: string };
export type OidcCallbackResult = { claims: OidcClaims; issuer: string; subject: string };

export function mergeOidcClaims(idTokenClaims: OidcClaims, userInfoClaims: OidcClaims | null | undefined): OidcClaims {
  if (!userInfoClaims) return idTokenClaims;
  return {
    ...idTokenClaims,
    ...userInfoClaims,
    iss: idTokenClaims.iss,
    sub: idTokenClaims.sub,
  };
}

export interface OidcAdapter {
  buildAuthorizationUrl(config: OidcProviderConfig, params: { state: string; nonce: string; codeVerifier: string }): Promise<string>;
  exchangeCallback(config: OidcProviderConfig, callbackUrl: string, checks: { state: string; nonce: string; codeVerifier: string }): Promise<OidcCallbackResult>;
  buildLogoutUrl(config: OidcProviderConfig): Promise<string | null>;
}

const truthy = new Set(["true", "1", "yes", "on"]);
const falsy = new Set(["false", "0", "no", "off"]);
function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  return truthy.has(raw.trim().toLowerCase());
}
function envString(name: string, defaultValue = ""): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? defaultValue : raw.trim();
}

function oidcStateEncryptionKey(config: OidcProviderConfig): Buffer {
  return crypto.createHash("sha256").update(`${config.clientSecret}:${config.providerKey}`).digest();
}

function sealTransientSecret(config: OidcProviderConfig, value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", oidcStateEncryptionKey(config), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function openTransientSecret(config: OidcProviderConfig, sealed: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = sealed.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("oidc_invalid_state_secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", oidcStateEncryptionKey(config), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
}

export function getOidcProviderConfig(): OidcProviderConfig {
  const baseUrl = getBaseUrl();
  return {
    enabled: envBool("OIDC_ENABLED", false),
    providerKey: envString("OIDC_PROVIDER_KEY", "primary_oidc"),
    issuerUrl: envString("OIDC_ISSUER_URL"),
    clientId: envString("OIDC_CLIENT_ID"),
    clientSecret: envString("OIDC_CLIENT_SECRET"),
    redirectUri: envString("OIDC_REDIRECT_URI", `${baseUrl}/api/v1/auth/oidc/callback`),
    scopes: envString("OIDC_SCOPES", "openid profile email"),
    postLogoutRedirectUri: envString("OIDC_POST_LOGOUT_REDIRECT_URI") || null,
    jitProvisioning: envBool("OIDC_JIT_PROVISIONING", false),
    syncClaimsOnLogin: envBool("OIDC_SYNC_CLAIMS_ON_LOGIN", true),
    syncAdmin: envBool("OIDC_SYNC_ADMIN", false),
    syncRoles: envBool("OIDC_SYNC_ROLES", false),
    claims: {
      email: envString("OIDC_CLAIM_EMAIL", "email"),
      emailVerified: envString("OIDC_CLAIM_EMAIL_VERIFIED", "email_verified"),
      name: envString("OIDC_CLAIM_NAME", "name"),
      username: envString("OIDC_CLAIM_USERNAME", "preferred_username"),
      avatar: envString("OIDC_CLAIM_AVATAR", "picture"),
      admin: envString("OIDC_CLAIM_ADMIN", "is_admin"),
      roles: envString("OIDC_CLAIM_ROLES", "roles"),
    },
  };
}

export function getLocalAuthConfig() {
  return {
    passwordAuthDisabled: envBool("DISABLE_LOCAL_PASSWORD_AUTH", false),
    registrationDisabled: envBool("DISABLE_LOCAL_REGISTRATION", false) || envBool("DISABLE_LOCAL_PASSWORD_AUTH", false),
  };
}

export function validateOidcConfig(config = getOidcProviderConfig()): string | null {
  if (!config.enabled) return null;
  if (!config.issuerUrl) return "oidc_issuer_url_missing";
  if (!config.clientId) return "oidc_client_id_missing";
  if (!config.clientSecret) return "oidc_client_secret_missing";
  if (!config.redirectUri) return "oidc_redirect_uri_missing";
  if (!config.scopes.split(/\s+/).includes("openid")) return "oidc_scope_openid_required";
  return null;
}

const SAFE_OIDC_ERROR_CODES = new Set([
  "account_disabled",
  "oidc_client_id_missing",
  "oidc_client_secret_missing",
  "oidc_disabled",
  "oidc_email_conflict",
  "oidc_invalid_state",
  "oidc_jit_provisioning_disabled",
  "oidc_issuer_url_missing",
  "oidc_login_failed",
  "oidc_missing_identity_claims",
  "oidc_redirect_uri_missing",
  "oidc_scope_openid_required",
  "oidc_verified_email_required",
]);

export function sanitizeOidcErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : null;
  return code && SAFE_OIDC_ERROR_CODES.has(code) ? code : "oidc_login_failed";
}

class OpenIdClientAdapter implements OidcAdapter {
  private configs = new Map<string, Promise<client.Configuration>>();

  private getClientConfig(config: OidcProviderConfig): Promise<client.Configuration> {
    const key = `${config.issuerUrl}\n${config.clientId}\n${config.redirectUri}`;
    const existing = this.configs.get(key);
    if (existing) return existing;
    const discovered = client.discovery(
      new URL(config.issuerUrl),
      config.clientId,
      { client_secret: config.clientSecret, redirect_uris: [config.redirectUri], response_types: ["code"] },
      client.ClientSecretPost(config.clientSecret),
    ).catch((error) => {
      this.configs.delete(key);
      throw error;
    });
    this.configs.set(key, discovered);
    return discovered;
  }

  async buildAuthorizationUrl(config: OidcProviderConfig, params: { state: string; nonce: string; codeVerifier: string }): Promise<string> {
    const oidcConfig = await this.getClientConfig(config);
    const challenge = await client.calculatePKCECodeChallenge(params.codeVerifier);
    return client.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: config.redirectUri,
      scope: config.scopes,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: params.state,
      nonce: params.nonce,
    }).toString();
  }

  async exchangeCallback(config: OidcProviderConfig, callbackUrl: string, checks: { state: string; nonce: string; codeVerifier: string }): Promise<OidcCallbackResult> {
    const oidcConfig = await this.getClientConfig(config);
    const tokens = await client.authorizationCodeGrant(oidcConfig, new URL(callbackUrl), {
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      pkceCodeVerifier: checks.codeVerifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.iss || !claims.sub) throw new Error("oidc_missing_identity_claims");
    const userInfoClaims = tokens.access_token && oidcConfig.serverMetadata().userinfo_endpoint
      ? await client.fetchUserInfo(oidcConfig, tokens.access_token, claims.sub) as OidcClaims
      : null;
    return {
      claims: mergeOidcClaims(claims as OidcClaims, userInfoClaims),
      issuer: claims.iss,
      subject: claims.sub,
    };
  }

  async buildLogoutUrl(config: OidcProviderConfig): Promise<string | null> {
    const oidcConfig = await this.getClientConfig(config);
    const metadata = oidcConfig.serverMetadata();
    if (!metadata.end_session_endpoint) return null;
    return client.buildEndSessionUrl(oidcConfig, config.postLogoutRedirectUri ? { post_logout_redirect_uri: config.postLogoutRedirectUri } : {}).toString();
  }
}

let oidcAdapter: OidcAdapter = new OpenIdClientAdapter();
export function getOidcAdapter() { return oidcAdapter; }
export function setOidcAdapterForTests(adapter: OidcAdapter) { oidcAdapter = adapter; }
export function resetOidcAdapterForTests() { oidcAdapter = new OpenIdClientAdapter(); }

function claimString(claims: OidcClaims, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function claimBool(claims: OidcClaims, key: string): boolean | null {
  const value = claims[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (truthy.has(normalized)) return true;
    if (falsy.has(normalized)) return false;
  }
  return null;
}
function claimList(claims: OidcClaims, key: string): string[] {
  const value = claims[key];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return values.map((item) => String(item).trim()).filter(Boolean).slice(0, 100);
}
function safeClaims(claims: OidcClaims): string {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(claims)) {
    if (/token|secret|password/i.test(key)) continue;
    clone[key] = value;
  }
  return JSON.stringify(clone).slice(0, 16_000);
}

export function isSafeRedirectTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function audit(db: DB, action: string, accountId: string, payload: Record<string, unknown>) {
  try {
    db.prepare("INSERT INTO admin_audit_log (id, admin_account_id, action_type, target_type, target_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(nanoid(), accountId, action, "account", accountId, JSON.stringify(payload));
  } catch {
    // Audit is best-effort for auth side effects in minimal test databases.
  }
}

function uniqueUsername(db: DB, preferred: string | null, email: string): string {
  const baseRaw = preferred || email.split("@")[0] || "user";
  const base = isValidRegistrationUsername(normalizeHandle(baseRaw)) ? normalizeHandle(baseRaw) : `user-${nanoid(6).toLowerCase()}`;
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    if (isValidRegistrationUsername(candidate) && !db.prepare("SELECT 1 FROM accounts WHERE username = ?").get(candidate)) return candidate;
  }
  return `user-${nanoid(10).toLowerCase()}`;
}

export function resolveOidcAccount(db: DB, config: OidcProviderConfig, result: OidcCallbackResult): { accountId: string; isNew: boolean } {
  const email = claimString(result.claims, config.claims.email)?.toLowerCase() ?? null;
  const emailVerified = claimBool(result.claims, config.claims.emailVerified) === true;
  const claimsJson = safeClaims(result.claims);

  const linked = db.prepare(
    `SELECT i.id AS identity_id, a.id AS account_id, a.is_disabled, a.password_hash
     FROM account_auth_identities i JOIN accounts a ON a.id = i.account_id
     WHERE i.provider_key = ? AND i.issuer = ? AND i.subject = ?`
  ).get(config.providerKey, result.issuer, result.subject) as { identity_id: string; account_id: string; is_disabled: number; password_hash: string | null } | undefined;

  if (linked) {
    if (linked.is_disabled) throw new Error("account_disabled");
    syncOidcAccount(db, config, linked.account_id, result.claims, linked.password_hash ? "hybrid" : "oidc");
    db.prepare("UPDATE account_auth_identities SET claims_json = ?, email_at_link_time = COALESCE(?, email_at_link_time), last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(claimsJson, email, linked.identity_id);
    return { accountId: linked.account_id, isNew: false };
  }

  if (!email || !emailVerified) throw new Error("oidc_verified_email_required");

  const matches = db.prepare("SELECT id, is_disabled FROM accounts WHERE lower(email) = ?").all(email) as Array<{ id: string; is_disabled: number }>;
  if (matches.length > 1) throw new Error("oidc_email_conflict");
  if (matches[0]) {
    if (matches[0].is_disabled) throw new Error("account_disabled");
    db.prepare(
      `INSERT INTO account_auth_identities (id, account_id, provider_key, issuer, subject, email_at_link_time, claims_json, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(nanoid(), matches[0].id, config.providerKey, result.issuer, result.subject, email, claimsJson);
    syncOidcAccount(db, config, matches[0].id, result.claims, "hybrid");
    audit(db, "oidc_account_linked", matches[0].id, { providerKey: config.providerKey, issuer: result.issuer, email });
    return { accountId: matches[0].id, isNew: false };
  }

  if (!config.jitProvisioning) throw new Error("oidc_jit_provisioning_disabled");

  const accountId = nanoid(16);
  const username = uniqueUsername(db, claimString(result.claims, config.claims.username), email);
  const displayName = claimString(result.claims, config.claims.name) || username;
  const avatarUrl = claimString(result.claims, config.claims.avatar);
  db.prepare(
    `INSERT INTO accounts (id, username, display_name, avatar_url, password_hash, email, email_verified, email_verified_at, city, city_lat, city_lng, timezone, date_time_locale, theme_preference, auth_source, last_oidc_login_at, oidc_profile_synced_at)
     VALUES (?, ?, ?, ?, NULL, ?, 1, datetime('now'), NULL, NULL, NULL, ?, ?, ?, 'oidc', datetime('now'), datetime('now'))`
  ).run(accountId, username, displayName, avatarUrl, email, SYSTEM_TIMEZONE, SYSTEM_DATE_TIME_LOCALE, SYSTEM_THEME_PREFERENCE);
  db.prepare(`INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled) VALUES (?, 1, 24, 1, 1)`).run(accountId);
  db.prepare(
    `INSERT INTO account_auth_identities (id, account_id, provider_key, issuer, subject, email_at_link_time, claims_json, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(nanoid(), accountId, config.providerKey, result.issuer, result.subject, email, claimsJson);
  syncOidcAccount(db, config, accountId, result.claims, "oidc");
  audit(db, "oidc_account_provisioned", accountId, { providerKey: config.providerKey, issuer: result.issuer, email });
  return { accountId, isNew: true };
}

function syncOidcAccount(db: DB, config: OidcProviderConfig, accountId: string, claims: OidcClaims, authSource: "oidc" | "hybrid") {
  if (!config.syncClaimsOnLogin) {
    db.prepare("UPDATE accounts SET auth_source = ?, last_oidc_login_at = datetime('now') WHERE id = ?").run(authSource, accountId);
    return;
  }
  const displayName = claimString(claims, config.claims.name);
  const avatarUrl = claimString(claims, config.claims.avatar);
  db.prepare(
    `UPDATE accounts
     SET auth_source = ?, last_oidc_login_at = datetime('now'), oidc_profile_synced_at = datetime('now'),
         display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), updated_at = datetime('now')
     WHERE id = ?`
  ).run(authSource, displayName, avatarUrl, accountId);

  if (config.syncAdmin) {
    const adminClaim = claimBool(claims, config.claims.admin);
    if (adminClaim !== null) {
      const row = db.prepare("SELECT is_admin, sso_admin_locked FROM accounts WHERE id = ?").get(accountId) as { is_admin: number; sso_admin_locked: number } | undefined;
      if (row && (adminClaim || !row.sso_admin_locked)) {
        const nextAdmin = adminClaim ? 1 : 0;
        if (row.is_admin !== nextAdmin) {
          db.prepare("UPDATE accounts SET is_admin = ?, updated_at = datetime('now') WHERE id = ?").run(nextAdmin, accountId);
          audit(db, nextAdmin ? "oidc_admin_granted" : "oidc_admin_revoked", accountId, { previous: !!row.is_admin, next: !!nextAdmin });
        }
      }
    }
  }

  if (config.syncRoles) {
    const roles = claimList(claims, config.claims.roles);
    db.prepare("DELETE FROM account_role_assignments WHERE account_id = ? AND source = 'oidc'").run(accountId);
    for (const role of roles) {
      db.prepare("INSERT OR IGNORE INTO account_role_assignments (id, account_id, role_key, source, managed_by) VALUES (?, ?, ?, 'oidc', ?)")
        .run(nanoid(), accountId, role, config.providerKey);
    }
  }
}

export function createOidcLoginState(db: DB, config: OidcProviderConfig, redirectTo?: string | null) {
  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO oidc_login_states (id, provider_key, state_hash, nonce_hash, code_verifier_hash, redirect_to, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(nanoid(), config.providerKey, hashTokenSecret(state), sealTransientSecret(config, nonce), sealTransientSecret(config, codeVerifier), isSafeRedirectTo(redirectTo), expiresAt);
  return { state, nonce, codeVerifier };
}

export function consumeOidcLoginState(db: DB, config: OidcProviderConfig, state: string) {
  const row = db.prepare(
    `UPDATE oidc_login_states
     SET consumed_at = datetime('now')
     WHERE provider_key = ?
       AND state_hash = ?
       AND consumed_at IS NULL
       AND julianday(expires_at) > julianday('now')
     RETURNING nonce_hash, code_verifier_hash, redirect_to`
  ).get(config.providerKey, hashTokenSecret(state)) as { nonce_hash: string; code_verifier_hash: string; redirect_to: string | null } | undefined;
  if (!row) throw new Error("oidc_invalid_state");
  return { nonce: openTransientSecret(config, row.nonce_hash), codeVerifier: openTransientSecret(config, row.code_verifier_hash), redirectTo: row.redirect_to || "/" };
}

export function randomLogoutState() {
  return crypto.randomBytes(16).toString("hex");
}
