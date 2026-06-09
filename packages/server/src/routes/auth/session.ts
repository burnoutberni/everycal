import type { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../../db.js";
import { hashPassword, verifyPassword, createSession, requireAuth, deleteSession, checkLoginAttempt, recordFailedLogin, clearFailedLogins } from "../../middleware/auth.js";
import { sendVerificationEmail } from "../../lib/email.js";
import { getLocale, t } from "../../lib/i18n.js";
import { normalizeHandle, isValidRegistrationUsername } from "../../lib/handles.js";
import { PASSWORD_MIN_LENGTH, meetsPasswordMinLength } from "@everycal/core";
import { parseJsonBody } from "../../lib/request-body.js";
import { hashTokenSecret } from "../../lib/token-secrets.js";
import { getEffectiveSetting } from "../../lib/runtime-settings.js";
import { getLocalAuthConfig, getOidcAdapter, getOidcProviderConfig } from "../../lib/oidc.js";
import { SYSTEM_TIMEZONE, SYSTEM_DATE_TIME_LOCALE, SYSTEM_THEME_PREFERENCE } from "./constants.js";
import { setSessionCookie, clearSessionCookie, maybeSetMissingCsrfCookie } from "./session-cookies.js";

function normalizeCityInput(city: unknown): string | null {
  if (typeof city !== "string") return null;
  const trimmed = city.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function registerSessionRoutes(router: Hono, db: DB): void {
  // Register
  router.post("/register", async (c) => {
    if (getLocalAuthConfig().registrationDisabled) {
      return c.json({ error: "local_auth_disabled" }, 403);
    }
    const openRegistrationsEffective = getEffectiveSetting<boolean>(db, "open_registrations", true);

    // Check if open registration is enabled
    if (!openRegistrationsEffective) {
      return c.json({ error: t(getLocale(c), "auth.registration_closed") }, 403);
    }

    const parsed = await parseJsonBody<{
      username: string;
      email?: string;
      password?: string;
      displayName?: string;
      city?: string;
      cityLat?: number;
      cityLng?: number;
      isBot?: boolean;
    }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    if (!body.username) {
      return c.json({ error: t(getLocale(c), "auth.username_required") }, 400);
    }

    const username = normalizeHandle(body.username);
    if (!isValidRegistrationUsername(username)) {
      return c.json({ error: t(getLocale(c), "auth.username_format") }, 400);
    }

    if (body.isBot !== undefined) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    const isBot = false;

    if (body.city !== undefined && typeof body.city !== "string") {
      return c.json({ error: t(getLocale(c), "auth.invalid_city") }, 400);
    }
    const normalizedCity = normalizeCityInput(body.city);

    // City required for non-bots; bots can use default
    const city = normalizedCity ?? "Wien";
    const cityLat = body.cityLat ?? 48.2082;
    const cityLng = body.cityLng ?? 16.3738;
    if (!isBot && (normalizedCity == null || body.cityLat == null || body.cityLng == null)) {
      return c.json({ error: "auth.city_required" }, 400);
    }

    // Email required for non-bots
    const email = body.email?.trim().toLowerCase();
    if (!isBot) {
      if (!email) return c.json({ error: t(getLocale(c), "auth.email_required") }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return c.json({ error: t(getLocale(c), "auth.invalid_email") }, 400);
      }
    }

    // Password required for non-bots; bots must remain API-key-only.
    if (isBot) {
      if (body.password !== undefined) {
        return c.json({ error: t(getLocale(c), "auth.bot_password_not_allowed") }, 400);
      }
    } else {
      if (!body.password || typeof body.password !== "string") {
        return c.json({ error: t(getLocale(c), "auth.password_required") }, 400);
      }
      if (!meetsPasswordMinLength(body.password, PASSWORD_MIN_LENGTH)) {
        return c.json({ error: t(getLocale(c), "auth.password_min_length", { min: PASSWORD_MIN_LENGTH }) }, 400);
      }
    }

    const existing = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
    if (existing) {
      return c.json({ error: t(getLocale(c), "auth.username_taken") }, 409);
    }

    if (!isBot && email) {
      const existingEmail = db.prepare("SELECT id FROM accounts WHERE email = ?").get(email);
      if (existingEmail) {
        return c.json({ error: t(getLocale(c), "auth.email_registered") }, 409);
      }
    }

    const id = nanoid(16);
    const passwordHash = isBot ? null : hashPassword(body.password as string);

    db.prepare(
      `INSERT INTO accounts (
         id, username, display_name, password_hash, email, email_verified, city, city_lat, city_lng, is_bot, timezone, date_time_locale
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      username,
      body.displayName || username,
      passwordHash,
      isBot ? null : email,
      isBot ? 1 : 0,
      city,
      cityLat,
      cityLng,
      isBot ? 1 : 0,
      SYSTEM_TIMEZONE,
      SYSTEM_DATE_TIME_LOCALE,
    );

    // Create default notification prefs
    db.prepare(
      `INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled)
       VALUES (?, 1, 24, 1, 1)`
    ).run(id);

    if (isBot) {
      const session = createSession(db, id);
      setSessionCookie(c, session.token, session.expiresAt);
      return c.json(
        {
          user: { id, username, displayName: body.displayName || username, city, cityLat, cityLng, themePreference: SYSTEM_THEME_PREFERENCE },
          expiresAt: session.expiresAt,
        },
        201
      );
    }

    // Human: send verification email, no session
    const token = nanoid(48);
    db.prepare(
      `INSERT INTO email_verification_tokens (account_id, token, expires_at)
       VALUES (?, ?, datetime('now', '+1 day'))`
    ).run(id, hashTokenSecret(token));

    await sendVerificationEmail(email!, token, getLocale(c));

    return c.json(
      {
        requiresVerification: true,
        email,
      },
      201
    );
  });

  // Verify email (registration or add/change email)

  router.post("/login", async (c) => {
    if (getLocalAuthConfig().passwordAuthDisabled) {
      return c.json({ error: "local_auth_disabled" }, 403);
    }
    const parsed = await parseJsonBody<{ username: string; password: string }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    if (typeof body.username !== "string" || typeof body.password !== "string" || !body.username || !body.password) {
      return c.json({ error: t(getLocale(c), "auth.username_password_required") }, 400);
    }

    const normalizedUsername = body.username.toLowerCase().trim();

    // Check account lockout (10 failed attempts → 15 min lockout)
    const lockout = checkLoginAttempt(db, normalizedUsername);
    if (lockout.locked) {
      return c.json(
        { error: t(getLocale(c), "auth.login_lockout", { minutes: lockout.remainingMinutes! }) },
        429
      );
    }

    const row = db
      .prepare(
        "SELECT id, username, display_name, password_hash, email_verified, theme_preference, is_bot, is_admin, is_disabled FROM accounts WHERE username = ?"
      )
      .get(normalizedUsername) as
      | {
          id: string;
          username: string;
          display_name: string | null;
          password_hash: string | null;
          email_verified: number;
          theme_preference: string | null;
          is_bot: number;
          is_admin: number;
          is_disabled: number;
        }
      | undefined;

    if (!row || row.is_bot || row.is_disabled || !row.password_hash || !verifyPassword(body.password, row.password_hash)) {
      recordFailedLogin(db, normalizedUsername);
      return c.json({ error: t(getLocale(c), "auth.invalid_username_password") }, 401);
    }

    if (!row.email_verified) {
      return c.json({ error: t(getLocale(c), "auth.verify_email_first") }, 403);
    }

    // Successful login — clear failed attempts
    clearFailedLogins(db, normalizedUsername);

    const session = createSession(db, row.id);

    const prefsRow = db
      .prepare(
        `SELECT reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed
         FROM account_notification_prefs WHERE account_id = ?`
      )
      .get(row.id) as
      | {
          reminder_enabled: number;
          reminder_hours_before: number;
          event_updated_enabled: number;
          event_cancelled_enabled: number;
          onboarding_completed: number;
        }
      | undefined;

    const notificationPrefs = prefsRow
      ? {
          reminderEnabled: !!prefsRow.reminder_enabled,
          reminderHoursBefore: prefsRow.reminder_hours_before,
          eventUpdatedEnabled: !!prefsRow.event_updated_enabled,
          eventCancelledEnabled: !!prefsRow.event_cancelled_enabled,
          onboardingCompleted: !!prefsRow.onboarding_completed,
        }
      : {
          reminderEnabled: true,
          reminderHoursBefore: 24,
          eventUpdatedEnabled: true,
          eventCancelledEnabled: true,
          onboardingCompleted: false,
        };

    setSessionCookie(c, session.token, session.expiresAt);

    return c.json({
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        isAdmin: !!row.is_admin,
        themePreference: row.theme_preference || SYSTEM_THEME_PREFERENCE,
        notificationPrefs,
      },
      expiresAt: session.expiresAt,
    });
  });

  // Forgot password

  router.post("/logout", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const cookieHeader = c.req.header("cookie") || "";
    const sessionMatch = cookieHeader.match(/everycal_session=([^\s;]+)/);
    const token = sessionMatch?.[1];
    const authHeader = c.req.header("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    const t = token || bearerToken;
    if (t) {
      deleteSession(db, t);
    }

    clearSessionCookie(c);

    const oidcConfig = getOidcProviderConfig();
    const logoutUrl = oidcConfig.enabled && user.sessionAuthMethod === "oidc"
      ? await getOidcAdapter().buildLogoutUrl(oidcConfig).catch(() => null)
      : null;
    return c.json({ ok: true, logoutUrl });
  });

  // Current user
  router.get("/me", requireAuth(), (c) => {
    maybeSetMissingCsrfCookie(c, c.req.header("cookie"), c.get("cookieSessionExpiresAt"));
    const user = c.get("user")!;
    const row = db
      .prepare(
        `SELECT id, username, display_name, bio, avatar_url, website, is_bot, discoverable, city, city_lat, city_lng, timezone, date_time_locale, email, email_verified, preferred_language, created_at, is_admin,
                theme_preference, auth_source,
                EXISTS(SELECT 1 FROM account_auth_identities i WHERE i.account_id = accounts.id) AS sso_linked,
                (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
                (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS followers_count
         FROM accounts WHERE id = ?`
      )
      .get(user.id, user.id, user.id) as Record<string, unknown>;

    const prefsRow = db
      .prepare(
        `SELECT reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed
         FROM account_notification_prefs WHERE account_id = ?`
      )
      .get(user.id) as
      | {
          reminder_enabled: number;
          reminder_hours_before: number;
          event_updated_enabled: number;
          event_cancelled_enabled: number;
          onboarding_completed: number;
        }
      | undefined;

    const notificationPrefs = prefsRow
      ? {
          reminderEnabled: !!prefsRow.reminder_enabled,
          reminderHoursBefore: prefsRow.reminder_hours_before,
          eventUpdatedEnabled: !!prefsRow.event_updated_enabled,
          eventCancelledEnabled: !!prefsRow.event_cancelled_enabled,
          onboardingCompleted: !!prefsRow.onboarding_completed,
        }
      : {
          reminderEnabled: true,
          reminderHoursBefore: 24,
          eventUpdatedEnabled: true,
          eventCancelledEnabled: true,
          onboardingCompleted: false,
        };

    return c.json({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio,
      avatarUrl: row.avatar_url,
      website: row.website || null,
      isBot: !!row.is_bot,
      isAdmin: !!row.is_admin,
      discoverable: !!row.discoverable,
      city: row.city || null,
      cityLat: row.city_lat != null ? Number(row.city_lat) : null,
      cityLng: row.city_lng != null ? Number(row.city_lng) : null,
      timezone: row.timezone || SYSTEM_TIMEZONE,
      dateTimeLocale: row.date_time_locale || SYSTEM_DATE_TIME_LOCALE,
      themePreference: row.theme_preference || SYSTEM_THEME_PREFERENCE,
      authSource: row.auth_source || "local",
      ssoLinked: !!row.sso_linked,
      email: row.email || null,
      emailVerified: !!row.email_verified,
      preferredLanguage: row.preferred_language || "en",
      followingCount: row.following_count,
      followersCount: row.followers_count,
      createdAt: row.created_at,
      notificationPrefs,
    });
  });

  // Update profile
}
