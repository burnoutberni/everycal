import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { authRoutes } from "../src/routes/auth.js";
import { authMiddleware, createSession, hashPassword } from "../src/middleware/auth.js";
import { setOidcAdapterForTests, type OidcAdapter, type OidcCallbackResult, type OidcProviderConfig } from "../src/lib/oidc.js";

const ORIGINAL_ENV = { ...process.env };

function makeApp(db: DB) {
  const app = new Hono();
  app.use("*", authMiddleware(db));
  app.route("/api/v1/auth", authRoutes(db));
  return app;
}

function configureOidc(extra: Record<string, string> = {}) {
  process.env.OIDC_ENABLED = "true";
  process.env.OIDC_ISSUER_URL = "https://idp.example.test/application/o/everycal/";
  process.env.OIDC_CLIENT_ID = "everycal";
  process.env.OIDC_CLIENT_SECRET = "secret";
  process.env.OIDC_REDIRECT_URI = "http://localhost/api/v1/auth/oidc/callback";
  process.env.BASE_URL = "http://localhost";
  Object.assign(process.env, extra);
}

function mockAdapter(result: OidcCallbackResult, logoutUrl: string | null = null): OidcAdapter {
  return {
    async buildAuthorizationUrl(_config: OidcProviderConfig, params) {
      return `https://idp.example.test/authorize?state=${encodeURIComponent(params.state)}&nonce=${encodeURIComponent(params.nonce)}`;
    },
    async exchangeCallback() {
      return result;
    },
    async buildLogoutUrl() {
      return logoutUrl;
    },
  };
}

function seedUser(db: DB, input: { id?: string; username?: string; email?: string; password?: string; isAdmin?: number; ssoAdminLocked?: number } = {}) {
  const id = input.id || "u1";
  const username = input.username || "alice";
  db.prepare(
    "INSERT INTO accounts (id, username, password_hash, email, email_verified, is_admin, sso_admin_locked) VALUES (?, ?, ?, ?, 1, ?, ?)"
  ).run(id, username, hashPassword(input.password || "secure-password"), input.email || `${username}@example.com`, input.isAdmin || 0, input.ssoAdminLocked || 0);
  db.prepare("INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled) VALUES (?, 1, 24, 1, 1)").run(id);
  return { id, username };
}

async function start(app: Hono, redirectTo = "/settings") {
  const res = await app.request("http://localhost/api/v1/auth/oidc/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirectTo }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { authorizationUrl: string };
  return new URL(body.authorizationUrl).searchParams.get("state")!;
}

describe("OIDC auth", () => {
  let db: DB;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configureOidc();
    db = initDatabase(":memory:");
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setOidcAdapterForTests(mockAdapter({ issuer: "https://idp.example.test/application/o/everycal/", subject: "sub", claims: { iss: "https://idp.example.test/application/o/everycal/", sub: "sub" } }));
  });

  it("start route returns an authorization URL only when enabled and configured", async () => {
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub" } }));
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/oidc/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    expect((await res.json() as { authorizationUrl: string }).authorizationUrl).toContain("/authorize");

    process.env.OIDC_ENABLED = "false";
    const disabled = await app.request("http://localhost/api/v1/auth/oidc/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(disabled.status).toBe(503);
  });

  it("callback rejects invalid or replayed state", async () => {
    const exchangeCallback = vi.fn(async () => ({
      issuer: process.env.OIDC_ISSUER_URL!,
      subject: "sub",
      claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub", email: "a@example.com", email_verified: true },
    }));
    setOidcAdapterForTests({
      async buildAuthorizationUrl(_config, params) {
        return `https://idp.example.test/authorize?state=${encodeURIComponent(params.state)}&nonce=${encodeURIComponent(params.nonce)}`;
      },
      exchangeCallback,
      async buildLogoutUrl() {
        return null;
      },
    });
    const app = makeApp(db);
    const invalid = await app.request("http://localhost/api/v1/auth/oidc/callback?state=missing&code=x");
    expect(invalid.status).toBe(302);
    expect(invalid.headers.get("location")).toContain("oidc_invalid_state");
    expect(exchangeCallback).not.toHaveBeenCalled();

    process.env.OIDC_JIT_PROVISIONING = "true";
    const state = await start(app);
    const first = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(first.status).toBe(302);
    expect(exchangeCallback).toHaveBeenCalledTimes(1);
    const replay = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(replay.headers.get("location")).toContain("oidc_invalid_state");
    expect(exchangeCallback).toHaveBeenCalledTimes(1);
  });

  it("auto-links an existing local account when verified email matches", async () => {
    seedUser(db, { id: "u_link", email: "alice@example.com" });
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub-link", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub-link", email: "alice@example.com", email_verified: true, name: "Alice SSO" } }));
    const app = makeApp(db);
    const state = await start(app);
    const res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("everycal_session=");
    const row = db.prepare("SELECT account_id FROM account_auth_identities WHERE subject = ?").get("sub-link") as { account_id: string };
    expect(row.account_id).toBe("u_link");
    const sessionRow = db.prepare("SELECT auth_method FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1").get("u_link") as { auth_method: string };
    expect(sessionRow.auth_method).toBe("oidc");
  });

  it("provisions a new local account only when JIT provisioning is enabled", async () => {
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub-new", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub-new", email: "new@example.com", email_verified: true, preferred_username: "newuser" } }));
    const app = makeApp(db);
    let state = await start(app);
    let res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.headers.get("location")).toContain("oidc_jit_provisioning_disabled");

    process.env.OIDC_JIT_PROVISIONING = "true";
    state = await start(app);
    res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.status).toBe(302);
    const row = db.prepare("SELECT id, auth_source, city, city_lat, city_lng FROM accounts WHERE email = ?").get("new@example.com") as {
      id: string;
      auth_source: string;
      city: string | null;
      city_lat: number | null;
      city_lng: number | null;
    };
    expect(row.auth_source).toBe("oidc");
    expect(row.city).toBeNull();
    expect(row.city_lat).toBeNull();
    expect(row.city_lng).toBeNull();
  });

  it("requires JIT-provisioned accounts to set a location before completing onboarding", async () => {
    process.env.OIDC_JIT_PROVISIONING = "true";
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub-onboarding", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub-onboarding", email: "jit@example.com", email_verified: true, preferred_username: "jituser" } }));
    const app = makeApp(db);
    const state = await start(app);
    const callbackRes = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    const sessionCookie = callbackRes.headers.get("set-cookie");

    expect(callbackRes.status).toBe(302);
    expect(sessionCookie).toContain("everycal_session=");

    const blocked = await app.request("http://localhost/api/v1/auth/notification-prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: sessionCookie! },
      body: JSON.stringify({ onboardingCompleted: true }),
    });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({ error: "auth.city_required" });

    const saveProfile = await app.request("http://localhost/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: sessionCookie! },
      body: JSON.stringify({ city: "Berlin", cityLat: 52.52, cityLng: 13.405 }),
    });
    expect(saveProfile.status).toBe(200);

    const complete = await app.request("http://localhost/api/v1/auth/notification-prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: sessionCookie! },
      body: JSON.stringify({ onboardingCompleted: true }),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ ok: true });
  });

  it("keeps JIT-provisioned SSO-only accounts as oidc on repeated login", async () => {
    process.env.OIDC_JIT_PROVISIONING = "true";
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub-repeat", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub-repeat", email: "repeat@example.com", email_verified: true, preferred_username: "repeatuser" } }));
    const app = makeApp(db);

    let state = await start(app);
    let res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.status).toBe(302);

    state = await start(app);
    res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.status).toBe(302);

    const row = db.prepare("SELECT auth_source, password_hash FROM accounts WHERE email = ?").get("repeat@example.com") as {
      auth_source: string;
      password_hash: string | null;
    };
    expect(row.password_hash).toBeNull();
    expect(row.auth_source).toBe("oidc");

    const me = await app.request("http://localhost/api/v1/auth/me", {
      headers: { cookie: res.headers.get("set-cookie")! },
    });
    expect(me.status).toBe(200);
    expect((await me.json() as { authSource: string }).authSource).toBe("oidc");
  });

  it("refuses auto-link/provision when verified email is absent, false, or malformed", async () => {
    process.env.OIDC_JIT_PROVISIONING = "true";
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub-no-verify", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub-no-verify", email: "new@example.com", email_verified: false } }));
    const app = makeApp(db);
    let state = await start(app);
    let res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.headers.get("location")).toContain("oidc_verified_email_required");

    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub-malformed-verify", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub-malformed-verify", email: "bad@example.com", email_verified: "verified" } }));
    state = await start(app);
    res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.headers.get("location")).toContain("oidc_verified_email_required");
  });

  it("sanitizes unexpected callback exceptions before redirecting", async () => {
    setOidcAdapterForTests({
      async buildAuthorizationUrl(_config, params) {
        return `https://idp.example.test/authorize?state=${encodeURIComponent(params.state)}&nonce=${encodeURIComponent(params.nonce)}`;
      },
      async exchangeCallback() {
        throw new Error("connect ECONNREFUSED https://idp.example.test/token");
      },
      async buildLogoutUrl() {
        return null;
      },
    });
    const app = makeApp(db);
    const state = await start(app);
    const res = await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("oidc_login_failed");
    expect(res.headers.get("location")).not.toContain("ECONNREFUSED");
    expect(res.headers.get("location")).not.toContain("idp.example.test");
  });

  it("disabled local password auth blocks /auth/login", async () => {
    seedUser(db);
    process.env.DISABLE_LOCAL_PASSWORD_AUTH = "true";
    const res = await makeApp(db).request("http://localhost/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: "secure-password" }) });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("local_auth_disabled");
  });

  it("syncs admin claims only when enabled and preserves locked local admin", async () => {
    seedUser(db, { id: "admin", email: "admin@example.com", isAdmin: 0 });
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "admin-sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "admin-sub", email: "admin@example.com", email_verified: true, is_admin: true } }));
    const app = makeApp(db);
    let state = await start(app);
    await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect((db.prepare("SELECT is_admin FROM accounts WHERE id = 'admin'").get() as { is_admin: number }).is_admin).toBe(0);

    process.env.OIDC_SYNC_ADMIN = "true";
    state = await start(app);
    await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect((db.prepare("SELECT is_admin FROM accounts WHERE id = 'admin'").get() as { is_admin: number }).is_admin).toBe(1);

    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "admin-sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "admin-sub", email: "admin@example.com", email_verified: true, is_admin: "administrator" } }));
    state = await start(app);
    await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect((db.prepare("SELECT is_admin FROM accounts WHERE id = 'admin'").get() as { is_admin: number }).is_admin).toBe(1);

    db.prepare("UPDATE accounts SET sso_admin_locked = 1 WHERE id = 'admin'").run();
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "admin-sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "admin-sub", email: "admin@example.com", email_verified: true, is_admin: false } }));
    state = await start(app);
    await app.request(`http://localhost/api/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=x`);
    expect((db.prepare("SELECT is_admin FROM accounts WHERE id = 'admin'").get() as { is_admin: number }).is_admin).toBe(1);
  });

  it("logout clears the OIDC session and returns provider logout URL", async () => {
    const user = seedUser(db);
    const session = createSession(db, user.id, "oidc");
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub" } }, "https://idp.example.test/logout"));
    const res = await makeApp(db).request("http://localhost/api/v1/auth/logout", { method: "POST", headers: { cookie: `everycal_session=${session.token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { logoutUrl: string };
    expect(body.logoutUrl).toBe("https://idp.example.test/logout");
    expect(res.headers.get("set-cookie")).toContain("everycal_session=");
  });

  it("does not return provider logout URL for a local session on a hybrid account", async () => {
    const user = seedUser(db);
    db.prepare("UPDATE accounts SET auth_source = 'hybrid' WHERE id = ?").run(user.id);
    const session = createSession(db, user.id, "local");
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub" } }, "https://idp.example.test/logout"));

    const res = await makeApp(db).request("http://localhost/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie: `everycal_session=${session.token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, logoutUrl: null });
  });

  it("oidc logout returns provider logout URL only for OIDC sessions", async () => {
    const user = seedUser(db);
    const session = createSession(db, user.id, "oidc");
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub" } }, "https://idp.example.test/logout"));

    const res = await makeApp(db).request("http://localhost/api/v1/auth/oidc/logout", {
      method: "POST",
      headers: { cookie: `everycal_session=${session.token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, logoutUrl: "https://idp.example.test/logout" });
    expect(res.headers.get("set-cookie")).toContain("everycal_session=");
  });

  it("oidc logout does not return provider logout URL for local sessions", async () => {
    const user = seedUser(db);
    db.prepare("UPDATE accounts SET auth_source = 'hybrid' WHERE id = ?").run(user.id);
    const session = createSession(db, user.id, "local");
    setOidcAdapterForTests(mockAdapter({ issuer: process.env.OIDC_ISSUER_URL!, subject: "sub", claims: { iss: process.env.OIDC_ISSUER_URL!, sub: "sub" } }, "https://idp.example.test/logout"));

    const res = await makeApp(db).request("http://localhost/api/v1/auth/oidc/logout", {
      method: "POST",
      headers: { cookie: `everycal_session=${session.token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, logoutUrl: null });
  });
});
