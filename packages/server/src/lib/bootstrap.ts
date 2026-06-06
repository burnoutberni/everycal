import type { Context } from "hono";
import type { AppBootstrap, AppLocale, BootstrapViewer } from "@everycal/core";
import { isAppLocale } from "@everycal/core";
import type { DB } from "../db.js";
import type { AuthUser } from "../middleware/auth.js";
import { readLocaleCookie, resolveLocale } from "./locale.js";

function loadViewer(db: DB, user: AuthUser | null): {
  viewer: BootstrapViewer | null;
  preferredLanguage?: AppLocale;
} {
  if (!user) return { viewer: null };

  const row = db
    .prepare(
      `SELECT a.id, a.username, a.display_name, a.avatar_url, a.preferred_language,
              a.theme_preference,
              p.onboarding_completed
       FROM accounts a
       LEFT JOIN account_notification_prefs p ON p.account_id = a.id
       WHERE a.id = ?`
    )
    .get(user.id) as
    | {
        id: string;
        username: string;
        display_name: string | null;
        avatar_url: string | null;
        preferred_language: string | null;
        theme_preference: "system" | "light" | "dark" | null;
        onboarding_completed: number | null;
      }
    | undefined;

  if (!row) {
    return {
      viewer: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
      preferredLanguage: isAppLocale(user.preferredLanguage) ? user.preferredLanguage : undefined,
    };
  }

  return {
    viewer: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      themePreference: row.theme_preference || "system",
      notificationPrefs: {
        onboardingCompleted: row.onboarding_completed != null ? !!row.onboarding_completed : undefined,
      },
    },
    preferredLanguage: isAppLocale(row.preferred_language) ? row.preferred_language : undefined,
  };
}

export function resolveBootstrap(c: Context, db: DB): AppBootstrap {
  const user = c.get("user") as AuthUser | null;
  const cookieHeader = c.req.header("cookie");
  const { viewer, preferredLanguage } = loadViewer(db, user);
  const cookieLocale = readLocaleCookie(cookieHeader);
  const locale = resolveLocale({
    userPreferred: preferredLanguage,
    cookieLocale,
    acceptLanguage: c.req.header("accept-language"),
    fallback: "en",
  });

  return {
    locale,
    viewer,
    isAuthenticated: viewer !== null,
  };
}
