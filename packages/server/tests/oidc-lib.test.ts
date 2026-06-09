import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase, type DB } from "../src/db.js";

const openIdMocks = vi.hoisted(() => ({
  ClientSecretPost: vi.fn(() => ({ kind: "client_secret_post" })),
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  buildEndSessionUrl: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  discovery: vi.fn(),
  fetchUserInfo: vi.fn(),
}));

vi.mock("openid-client", () => openIdMocks);

import { getOidcAdapter, getOidcProviderConfig, mergeOidcClaims, resetOidcAdapterForTests, resolveOidcAccount, safeClaims, type OidcCallbackResult } from "../src/lib/oidc.js";
import { hashPassword } from "../src/middleware/auth.js";

const ORIGINAL_ENV = { ...process.env };

function configureOidc() {
  process.env.OIDC_ENABLED = "true";
  process.env.OIDC_ISSUER_URL = "https://idp.example.test/application/o/everycal/";
  process.env.OIDC_CLIENT_ID = "everycal";
  process.env.OIDC_CLIENT_SECRET = "secret";
  process.env.OIDC_REDIRECT_URI = "http://localhost/api/v1/auth/oidc/callback";
  process.env.BASE_URL = "http://localhost";
}

function seedUser(db: DB, input: { id: string; username: string; email: string; password?: string }) {
  db.prepare(
    "INSERT INTO accounts (id, username, password_hash, email, email_verified) VALUES (?, ?, ?, ?, 1)"
  ).run(input.id, input.username, hashPassword(input.password || "secure-password"), input.email);
  db.prepare("INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled) VALUES (?, 1, 24, 1, 1)").run(input.id);
}

function oidcResult(input: { subject: string; email?: string; emailVerified?: boolean; username?: string; name?: string }): OidcCallbackResult {
  return {
    issuer: process.env.OIDC_ISSUER_URL!,
    subject: input.subject,
    claims: {
      iss: process.env.OIDC_ISSUER_URL!,
      sub: input.subject,
      ...(input.email ? { email: input.email } : {}),
      ...(input.emailVerified !== undefined ? { email_verified: input.emailVerified } : {}),
      ...(input.username ? { preferred_username: input.username } : {}),
      ...(input.name ? { name: input.name } : {}),
    },
  };
}

describe("OIDC library", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configureOidc();
    vi.clearAllMocks();
    resetOidcAdapterForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("merges UserInfo claims into callback claims while preserving verified iss/sub", async () => {
    openIdMocks.discovery.mockResolvedValue({
      serverMetadata: () => ({ userinfo_endpoint: "https://idp.example.test/application/o/everycal/userinfo" }),
    });
    openIdMocks.authorizationCodeGrant.mockResolvedValue({
      access_token: "access-token",
      claims: () => ({
        iss: process.env.OIDC_ISSUER_URL!,
        sub: "verified-subject",
        name: "Alice From ID Token",
      }),
    });
    openIdMocks.fetchUserInfo.mockResolvedValue({
      iss: "https://attacker.example.test/",
      sub: "tampered-subject",
      email: "alice@example.com",
      email_verified: true,
      preferred_username: "alice-sso",
    });

    const result = await getOidcAdapter().exchangeCallback(getOidcProviderConfig(), "http://localhost/api/v1/auth/oidc/callback?state=s&code=x", {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
    });

    expect(openIdMocks.fetchUserInfo).toHaveBeenCalledWith(expect.anything(), "access-token", "verified-subject");
    expect(result).toEqual({
      issuer: process.env.OIDC_ISSUER_URL!,
      subject: "verified-subject",
      claims: {
        iss: process.env.OIDC_ISSUER_URL!,
        sub: "verified-subject",
        name: "Alice From ID Token",
        email: "alice@example.com",
        email_verified: true,
        preferred_username: "alice-sso",
      },
    });
  });

  it("skips UserInfo when the provider does not advertise the endpoint", async () => {
    process.env.OIDC_CLIENT_ID = "everycal-without-userinfo";
    openIdMocks.discovery.mockResolvedValue({
      serverMetadata: () => ({}),
    });
    openIdMocks.authorizationCodeGrant.mockResolvedValue({
      access_token: "access-token",
      claims: () => ({ iss: process.env.OIDC_ISSUER_URL!, sub: "verified-subject" }),
    });

    const result = await getOidcAdapter().exchangeCallback(getOidcProviderConfig(), "http://localhost/api/v1/auth/oidc/callback?state=s&code=x", {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
    });

    expect(openIdMocks.fetchUserInfo).not.toHaveBeenCalled();
    expect(result.claims).toEqual({ iss: process.env.OIDC_ISSUER_URL!, sub: "verified-subject" });
  });

  it("retries discovery after a transient failure", async () => {
    openIdMocks.discovery
      .mockRejectedValueOnce(new Error("temporary discovery failure"))
      .mockResolvedValueOnce({
        serverMetadata: () => ({}),
      });
    openIdMocks.calculatePKCECodeChallenge.mockResolvedValue("challenge");
    openIdMocks.buildAuthorizationUrl.mockReturnValue(new URL("https://idp.example.test/authorize"));

    await expect(getOidcAdapter().buildAuthorizationUrl(getOidcProviderConfig(), {
      state: "s1",
      nonce: "n1",
      codeVerifier: "v1",
    })).rejects.toThrow("temporary discovery failure");

    await expect(getOidcAdapter().buildAuthorizationUrl(getOidcProviderConfig(), {
      state: "s2",
      nonce: "n2",
      codeVerifier: "v2",
    })).resolves.toBe("https://idp.example.test/authorize");

    expect(openIdMocks.discovery).toHaveBeenCalledTimes(2);
  });

  it("mergeOidcClaims preserves iss/sub from the ID token", () => {
    expect(mergeOidcClaims(
      { iss: "https://issuer.example.test/", sub: "trusted-subject", name: "Alice" },
      { iss: "https://other.example.test/", sub: "other-subject", email: "alice@example.com", email_verified: true },
    )).toEqual({
      iss: "https://issuer.example.test/",
      sub: "trusted-subject",
      name: "Alice",
      email: "alice@example.com",
      email_verified: true,
    });
  });

  it("rolls back auto-link writes when a later account sync step fails", () => {
    const db = initDatabase(":memory:");
    seedUser(db, { id: "u-link", username: "alice", email: "alice@example.com" });

    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("SET auth_source = ?")) throw new Error("sync failed");
      return originalPrepare(sql);
    });

    expect(() => resolveOidcAccount(db, getOidcProviderConfig(), oidcResult({
      subject: "sub-link",
      email: "alice@example.com",
      emailVerified: true,
      name: "Alice SSO",
    }))).toThrow("sync failed");

    expect(db.prepare("SELECT account_id FROM account_auth_identities WHERE subject = ?").get("sub-link")).toBeUndefined();
    expect((db.prepare("SELECT auth_source, last_oidc_login_at FROM accounts WHERE id = ?").get("u-link") as { auth_source: string; last_oidc_login_at: string | null })).toEqual({
      auth_source: "local",
      last_oidc_login_at: null,
    });
  });

  it("rolls back JIT provisioning when a later insert fails", () => {
    process.env.OIDC_JIT_PROVISIONING = "true";
    const db = initDatabase(":memory:");

    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("INSERT INTO account_notification_prefs")) throw new Error("prefs failed");
      return originalPrepare(sql);
    });

    expect(() => resolveOidcAccount(db, getOidcProviderConfig(), oidcResult({
      subject: "sub-new",
      email: "new@example.com",
      emailVerified: true,
      username: "newuser",
    }))).toThrow("prefs failed");

    expect(db.prepare("SELECT id FROM accounts WHERE email = ?").get("new@example.com")).toBeUndefined();
    expect(db.prepare("SELECT account_id FROM account_auth_identities WHERE subject = ?").get("sub-new")).toBeUndefined();
  });

  it("rolls back linked-account updates when the identity refresh fails", () => {
    const db = initDatabase(":memory:");
    seedUser(db, { id: "u-linked", username: "linked", email: "linked@example.com" });
    db.prepare(
      `INSERT INTO account_auth_identities (id, account_id, provider_key, issuer, subject, email_at_link_time, claims_json, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run("ident-1", "u-linked", getOidcProviderConfig().providerKey, process.env.OIDC_ISSUER_URL!, "sub-linked", "linked@example.com", '{"email":"old@example.com"}');

    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("UPDATE account_auth_identities SET claims_json = ?")) throw new Error("identity refresh failed");
      return originalPrepare(sql);
    });

    expect(() => resolveOidcAccount(db, getOidcProviderConfig(), oidcResult({
      subject: "sub-linked",
      email: "linked@example.com",
      emailVerified: true,
      name: "Linked SSO",
    }))).toThrow("identity refresh failed");

    expect((db.prepare("SELECT auth_source, last_oidc_login_at FROM accounts WHERE id = ?").get("u-linked") as { auth_source: string; last_oidc_login_at: string | null })).toEqual({
      auth_source: "local",
      last_oidc_login_at: null,
    });
    expect((db.prepare("SELECT claims_json FROM account_auth_identities WHERE id = ?").get("ident-1") as { claims_json: string }).claims_json).toBe('{"email":"old@example.com"}');
  });
});

describe("safeClaims", () => {
  it("strips keys matching token/secret/password patterns", () => {
    const result = safeClaims({ email: "a@b.com", access_token: "x", user_secret: "y", password_hash: "z", name: "Alice" });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ email: "a@b.com", name: "Alice" });
  });

  it("returns valid JSON for normal-sized claims", () => {
    const claims = { sub: "123", email: "user@example.com", name: "Test User", roles: ["admin", "editor"] };
    const parsed = JSON.parse(safeClaims(claims));
    expect(parsed).toEqual(claims);
  });

  it("truncates long string values to ~2KB and appends ellipsis", () => {
    const longString = "x".repeat(4_000);
    const result = JSON.parse(safeClaims({ big: longString }));
    expect(Buffer.byteLength(result.big, "utf8")).toBeLessThanOrEqual(2_051);
    expect(result.big.endsWith("…")).toBe(true);
  });

  it("truncates UTF-8 multibyte strings on valid character boundary", () => {
    const emoji = "é".repeat(2_000);
    const result = JSON.parse(safeClaims({ text: emoji }));
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.text.length).toBeLessThan(emoji.length);
  });

  it("caps arrays at 50 entries", () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => `item-${i}`);
    const result = JSON.parse(safeClaims({ groups: bigArray }));
    expect(result.groups).toHaveLength(50);
    expect(result.groups[0]).toBe("item-0");
    expect(result.groups[49]).toBe("item-49");
  });

  it("recursively truncates string values inside arrays", () => {
    const longEntry = "a".repeat(4_000);
    const result = JSON.parse(safeClaims({ groups: [longEntry, "short"] }));
    expect(Buffer.byteLength(result.groups[0], "utf8")).toBeLessThanOrEqual(2_051);
    expect(result.groups[0].endsWith("…")).toBe(true);
    expect(result.groups[1]).toBe("short");
  });

  it("recursively truncates nested objects", () => {
    const longVal = "b".repeat(4_000);
    const result = JSON.parse(safeClaims({ profile: { bio: longVal, name: "OK" } }));
    expect(Buffer.byteLength(result.profile.bio, "utf8")).toBeLessThanOrEqual(2_051);
    expect(result.profile.bio.endsWith("…")).toBe(true);
    expect(result.profile.name).toBe("OK");
  });

  it("produces always-valid JSON even with extreme payloads", () => {
    const extreme = {
      a: "x".repeat(100_000),
      b: Array.from({ length: 10_000 }, () => "y".repeat(500)),
      c: { deep: { deeper: { deepest: "z".repeat(50_000) } } },
    };
    const result = safeClaims(extreme);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(result.length).toBeLessThanOrEqual(16_000);
  });

  it("preserves non-string non-array non-object values unchanged", () => {
    const claims = { num: 42, bool: true, nil: null, nested: { ok: true } };
    const result = JSON.parse(safeClaims(claims));
    expect(result).toEqual(claims);
  });
});
