import { isAppLocale, type AppLocale } from "@everycal/core";

export const LOCALE_COOKIE = "everycal_locale";
const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function parseCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]+)`));
  return match?.[1];
}

export function parseAcceptLanguage(header: string | undefined): AppLocale {
  if (!header) return "en";
  const ranked = header.split(",").map((part) => {
    const [langPart, qPart] = part.trim().split(";q=");
    const lang = langPart.trim().toLowerCase().split("-")[0];
    const q = Number.parseFloat(qPart || "1");
    return { lang, q: Number.isFinite(q) ? q : 1 };
  });
  ranked.sort((a, b) => b.q - a.q);
  for (const { lang } of ranked) {
    if (isAppLocale(lang)) return lang;
  }
  return "en";
}

export function readLocaleCookie(cookieHeader: string | undefined): AppLocale | undefined {
  const value = parseCookieValue(cookieHeader, LOCALE_COOKIE);
  if (!value) return undefined;
  const decoded = decodeURIComponent(value);
  return isAppLocale(decoded) ? decoded : undefined;
}

export function buildLocaleCookie(locale: AppLocale): string {
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [
    `${LOCALE_COOKIE}=${locale}`,
    "Path=/",
    `Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (isProduction) parts.push("Secure");
  return parts.join("; ");
}

export function resolveLocale(input: {
  userPreferred?: string | null;
  cookieLocale?: AppLocale;
  acceptLanguage?: string;
  fallback?: AppLocale;
}): AppLocale {
  const fallback = input.fallback ?? "en";
  const userLocale = isAppLocale(input.userPreferred) ? input.userPreferred : undefined;
  return userLocale || input.cookieLocale || parseAcceptLanguage(input.acceptLanguage) || fallback;
}

export function shouldSetLocaleCookie(cookieHeader: string | undefined, locale: AppLocale): boolean {
  return readLocaleCookie(cookieHeader) !== locale;
}
