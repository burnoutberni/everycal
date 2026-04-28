import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { authRoutes } from "../src/routes/auth.js";
import { createSession, hashPassword } from "../src/middleware/auth.js";
import { hashTokenSecret } from "../src/lib/token-secrets.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/api/v1/auth", authRoutes(db));
  return app;
}

describe("auth bot password restrictions", () => {
  let db: DB;

  beforeEach(() => {
    process.env.OPEN_REGISTRATIONS = "true";
    db = initDatabase(":memory:");
  });

  it("rejects registration when isBot flag is provided", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bot_with_pw", isBot: true }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "common.requestFailed" });
    const created = db.prepare("SELECT id FROM accounts WHERE username = ?").get("bot_with_pw") as { id: string } | undefined;
    expect(created).toBeUndefined();
  });

  it("stores reset tokens hashed and resolves hashed lookup", async () => {
    db.prepare("INSERT INTO accounts (id, username, email, email_verified, is_bot) VALUES (?, ?, ?, 1, 0)")
      .run("u2", "bob", "bob@example.com");
    const app = makeApp(db);

    await app.request("http://localhost/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com" }),
    });

    const stored = db.prepare("SELECT token FROM password_reset_tokens WHERE account_id = ?").get("u2") as { token: string };
    expect(stored.token).toMatch(/^[a-f0-9]{64}$/);

    db.prepare("UPDATE password_reset_tokens SET token = ? WHERE account_id = ?").run(hashTokenSecret("known-token"), "u2");
    const resetRes = await app.request("http://localhost/api/v1/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "known-token", newPassword: "new-password-123" }),
    });
    expect(resetRes.status).toBe(200);
  });

  it("does not allow toggling isBot via auth endpoints", async () => {
    db.prepare("INSERT INTO accounts (id, username, password_hash, email_verified, is_bot) VALUES (?, ?, ?, 1, 0)")
      .run("u3", "carol", hashPassword("pw"));
    const app = makeApp(db, { id: "u3", username: "carol" });

    const registerRes = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "x", isBot: true }),
    });
    expect(registerRes.status).toBe(400);

    const patchRes = await app.request("http://localhost/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isBot: true, displayName: "Carol" }),
    });
    expect(patchRes.status).toBe(200);
    const row = db.prepare("SELECT is_bot FROM accounts WHERE id = ?").get("u3") as { is_bot: number };
    expect(row.is_bot).toBe(0);
  });

  it("returns 400 for malformed JSON on auth login route", async () => {
    const app = makeApp(db);
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u1", "alice");

    const res = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });

  it("creates normal user account when isBot is omitted", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "person_nopw",
        email: "person@example.com",
        password: "very-secure-password",
        city: "Vienna",
        cityLat: 48.2,
        cityLng: 16.37,
      }),
    });

    expect(res.status).toBe(201);
    const account = db
      .prepare("SELECT is_bot, password_hash FROM accounts WHERE username = ?")
      .get("person_nopw") as { is_bot: number; password_hash: string | null } | undefined;
    expect(account?.is_bot).toBe(0);
    expect(account?.password_hash).toBeTruthy();
  });

  it("rejects password login for bot accounts", async () => {
    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email_verified, is_bot) VALUES (?, ?, ?, ?, ?)"
    ).run("bot1", "bot_login", hashPassword("secret-password"), 1, 1);

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bot_login", password: "secret-password" }),
    });

    expect(res.status).toBe(401);
  });

  it("does not create password reset tokens for bot accounts", async () => {
    db.prepare("INSERT INTO accounts (id, username, email, email_verified, is_bot) VALUES (?, ?, ?, ?, ?)").run(
      "bot2",
      "bot_forgot",
      "bot@example.com",
      1,
      1
    );

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bot@example.com" }),
    });

    expect(res.status).toBe(200);
    const token = db
      .prepare("SELECT account_id FROM password_reset_tokens WHERE account_id = ?")
      .get("bot2") as { account_id: string } | undefined;
    expect(token).toBeUndefined();
  });

  it("stores password reset token expiry in sqlite datetime format", async () => {
    db.prepare("INSERT INTO accounts (id, username, email, email_verified, is_bot) VALUES (?, ?, ?, ?, ?)").run(
      "person-reset-format",
      "person_reset_format",
      "person-reset-format@example.com",
      1,
      0
    );

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person-reset-format@example.com" }),
    });

    expect(res.status).toBe(200);
    const token = db.prepare("SELECT expires_at FROM password_reset_tokens WHERE account_id = ?").get("person-reset-format") as
      | { expires_at: string }
      | undefined;
    expect(token?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const parsed = db.prepare("SELECT datetime(?) AS parsed").get(token?.expires_at ?? null) as { parsed: string | null };
    expect(parsed.parsed).toBe(token?.expires_at);
  });

  it("stores session expiry in sqlite datetime format", () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, ?)").run("person-session-format", "person_session_format", 1);

    const session = createSession(db, "person-session-format");
    const stored = db.prepare("SELECT expires_at FROM sessions WHERE account_id = ?").get("person-session-format") as
      | { expires_at: string }
      | undefined;

    expect(stored?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const parsed = db.prepare("SELECT datetime(?) AS parsed").get(stored?.expires_at ?? null) as { parsed: string | null };
    expect(parsed.parsed).toBe(stored?.expires_at);
    expect(new Date(session.expiresAt).toISOString()).toBe(session.expiresAt);
  });

  it("rejects reset-password token for bot accounts", async () => {
    const oldHash = hashPassword("old-secret");
    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email, email_verified, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("bot3", "bot_reset", oldHash, "bot-reset@example.com", 1, 1);
    db.prepare(
      "INSERT INTO password_reset_tokens (account_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 minute'))"
    ).run("bot3", hashTokenSecret("bot-token"));

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "bot-token", newPassword: "new-strong-password" }),
    });

    expect(res.status).toBe(400);
    const account = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get("bot3") as { password_hash: string };
    expect(account.password_hash).toBe(oldHash);
  });

  it("rejects reset-password when newPassword is non-string", async () => {
    const oldHash = hashPassword("old-secret");
    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email, email_verified, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("person-reset-1", "person_reset_1", oldHash, "person-reset-1@example.com", 1, 0);
    db.prepare(
      "INSERT INTO password_reset_tokens (account_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 minute'))"
    ).run("person-reset-1", hashTokenSecret("person-token-1"));

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "person-token-1", newPassword: true }),
    });

    expect(res.status).toBe(400);
    const account = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get("person-reset-1") as {
      password_hash: string;
    };
    expect(account.password_hash).toBe(oldHash);
  });

  it("rejects reset-password when token is non-string", async () => {
    const oldHash = hashPassword("old-secret");
    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email, email_verified, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("person-reset-2", "person_reset_2", oldHash, "person-reset-2@example.com", 1, 0);
    db.prepare(
      "INSERT INTO password_reset_tokens (account_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 minute'))"
    ).run("person-reset-2", hashTokenSecret("person-token-2"));

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: { value: "person-token-2" }, newPassword: "new-strong-password" }),
    });

    expect(res.status).toBe(400);
    const account = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get("person-reset-2") as {
      password_hash: string;
    };
    expect(account.password_hash).toBe(oldHash);
  });

  it("rejects change-password for authenticated bot accounts", async () => {
    const oldHash = hashPassword("old-bot-password");
    db.prepare("INSERT INTO accounts (id, username, password_hash, is_bot) VALUES (?, ?, ?, ?)").run(
      "bot4",
      "bot_change",
      oldHash,
      1
    );

    const app = makeApp(db, { id: "bot4", username: "bot_change" });
    const res = await app.request("http://localhost/api/v1/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "old-bot-password", newPassword: "new-strong-password" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Bot accounts cannot use passwords. Use API keys instead.",
    });
    const account = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get("bot4") as { password_hash: string };
    expect(account.password_hash).toBe(oldHash);
  });

  it("rejects change-password when currentPassword is non-string", async () => {
    const oldHash = hashPassword("old-person-password");
    db.prepare("INSERT INTO accounts (id, username, password_hash, is_bot) VALUES (?, ?, ?, ?)").run(
      "person-change-1",
      "person_change_1",
      oldHash,
      0
    );

    const app = makeApp(db, { id: "person-change-1", username: "person_change_1" });
    const res = await app.request("http://localhost/api/v1/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: { value: "old-person-password" }, newPassword: "new-strong-password" }),
    });

    expect(res.status).toBe(400);
    const account = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get("person-change-1") as {
      password_hash: string;
    };
    expect(account.password_hash).toBe(oldHash);
  });

  it("rejects change-password when newPassword is non-string", async () => {
    const oldHash = hashPassword("old-person-password");
    db.prepare("INSERT INTO accounts (id, username, password_hash, is_bot) VALUES (?, ?, ?, ?)").run(
      "person-change-2",
      "person_change_2",
      oldHash,
      0
    );

    const app = makeApp(db, { id: "person-change-2", username: "person_change_2" });
    const res = await app.request("http://localhost/api/v1/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "old-person-password", newPassword: true }),
    });

    expect(res.status).toBe(400);
    const account = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get("person-change-2") as {
      password_hash: string;
    };
    expect(account.password_hash).toBe(oldHash);
  });

  it("still allows password login for non-bot accounts", async () => {
    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email_verified, is_bot) VALUES (?, ?, ?, ?, ?)"
    ).run("person1", "person_login", hashPassword("person-password"), 1, 0);

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "person_login", password: "person-password" }),
    });

    expect(res.status).toBe(200);
  });
});
