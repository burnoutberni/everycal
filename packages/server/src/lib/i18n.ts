/**
 * Server-side i18n: locale resolution and message translation.
 */

import type { Context } from "hono";
import en from "../i18n/en.json" with { type: "json" };
import de from "../i18n/de.json" with { type: "json" };

const SUPPORTED_LOCALES = ["en", "de"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const messages: Record<SupportedLocale, Record<string, unknown>> = { en, de };

function isSupported(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.includes(locale as SupportedLocale);
}

/** Parse Accept-Language header and return first supported locale, or "en". */
function parseAcceptLanguage(header: string | undefined): SupportedLocale {
  if (!header) return "en";
  const parts = header.split(",").map((p) => {
    const [lang, q = "1"] = p.trim().split(";q=");
    return { lang: lang.trim().toLowerCase().split("-")[0], q: parseFloat(q) || 1 };
  });
  parts.sort((a, b) => b.q - a.q);
  for (const { lang } of parts) {
    if (isSupported(lang)) return lang;
  }
  return "en";
}

/** Get locale for the request: user preference > Accept-Language > en */
export function getLocale(c: Context): SupportedLocale {
  try {
    const user = c.get("user") as { preferredLanguage?: string } | null | undefined;
    if (user?.preferredLanguage && isSupported(user.preferredLanguage)) {
      return user.preferredLanguage as SupportedLocale;
    }
  } catch {
    // user not set (e.g. before auth middleware runs)
  }
  const acceptLang = c.req.header("Accept-Language");
  return parseAcceptLanguage(acceptLang);
}

function getNested(obj: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * Translate a key for the given locale. Supports {{param}} interpolation.
 * Falls back to English if the key is missing in the target locale.
 */
export function t(
  locale: SupportedLocale,
  key: string,
  params?: Record<string, string | number>
): string {
  let str =
    getNested(messages[locale] as Record<string, unknown>, key) ??
    getNested(messages.en as Record<string, unknown>, key) ??
    key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return str;
}
