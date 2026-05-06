import { Hono } from "hono";
import { initDatabase, type DB } from "../../src/db.js";
import { authRoutes } from "../../src/routes/auth.js";
import { eventRoutes } from "../../src/routes/events.js";
import { hashPassword } from "../../src/middleware/auth.js";

export type AuthUserContext = { id: string; username: string };

export type ContractTestApp = {
  app: Hono;
  db: DB;
  asUser: (user: AuthUserContext | null) => Hono;
  seedUser: (overrides?: Partial<SeedUserInput>) => AuthUserContext;
  seedEvent: (input: SeedEventInput) => { id: string };
};

type SeedUserInput = {
  id: string;
  username: string;
  email: string | null;
  emailVerified: number;
  isBot: number;
  password: string | null;
};

type SeedEventInput = {
  id: string;
  accountId: string;
  slug: string;
  title: string;
  startDate: string;
  startAtUtc: string;
};

function createMountedApp(db: DB, user: AuthUserContext | null = null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/api/v1/auth", authRoutes(db));
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

export function createContractTestApp(user: AuthUserContext | null = null): ContractTestApp {
  const db = initDatabase(":memory:");
  let userCounter = 0;

  const seedUser = (overrides: Partial<SeedUserInput> = {}): AuthUserContext => {
    userCounter += 1;
    const id = overrides.id ?? `u${userCounter}`;
    const username = overrides.username ?? `user_${userCounter}`;
    const email = overrides.email === undefined ? `${username}@example.com` : overrides.email;
    const emailVerified = overrides.emailVerified ?? 1;
    const isBot = overrides.isBot ?? 0;
    const password = overrides.password === undefined ? "pw" : overrides.password;
    const passwordHash = password ? hashPassword(password) : null;

    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email, email_verified, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, username, passwordHash, email, emailVerified, isBot);

    db.prepare(
      `INSERT OR IGNORE INTO account_notification_prefs (
        account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled
      ) VALUES (?, 1, 24, 1, 1)`
    ).run(id);

    return { id, username };
  };

  const seedEvent = (input: SeedEventInput): { id: string } => {
    db.prepare(
      `INSERT INTO events (
        id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility
      ) VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`
    ).run(input.id, input.accountId, input.slug, input.title, input.startDate, input.startAtUtc);
    return { id: input.id };
  };

  return {
    app: createMountedApp(db, user),
    db,
    asUser: (nextUser: AuthUserContext | null) => createMountedApp(db, nextUser),
    seedUser,
    seedEvent,
  };
}
