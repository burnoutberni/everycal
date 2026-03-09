import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { isAppLocale, type AppLocale } from "@everycal/core";
import enCommon from "./locales/en/common.json";
import enAuth from "./locales/en/auth.json";
import enEvents from "./locales/en/events.json";
import enCalendar from "./locales/en/calendar.json";
import enDiscover from "./locales/en/discover.json";
import enProfile from "./locales/en/profile.json";
import enSettings from "./locales/en/settings.json";
import enOnboarding from "./locales/en/onboarding.json";
import enCreateEvent from "./locales/en/createEvent.json";
import enTimezones from "./locales/en/timezones.json";
import deCommon from "./locales/de/common.json";
import deAuth from "./locales/de/auth.json";
import deEvents from "./locales/de/events.json";
import deCalendar from "./locales/de/calendar.json";
import deDiscover from "./locales/de/discover.json";
import deProfile from "./locales/de/profile.json";
import deSettings from "./locales/de/settings.json";
import deOnboarding from "./locales/de/onboarding.json";
import deCreateEvent from "./locales/de/createEvent.json";
import deTimezones from "./locales/de/timezones.json";

export const STORAGE_KEY = "everycal_locale";

let initPromise: Promise<void> | null = null;

function getCookieLocale(): AppLocale | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)everycal_locale=([^;]+)/);
  if (!match) return undefined;
  const value = decodeURIComponent(match[1]);
  return isAppLocale(value) ? value : undefined;
}

function persistLocale(locale: AppLocale) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, locale);
  document.cookie = `${STORAGE_KEY}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  document.documentElement.lang = locale;
}

export function getPreferredLanguage(): AppLocale {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isAppLocale(stored)) return stored;
  const cookie = getCookieLocale();
  if (cookie) return cookie;
  const browser = navigator.language?.toLowerCase().split("-")[0];
  return browser === "de" ? "de" : "en";
}

function updateDocumentHead() {
  if (typeof document === "undefined") return;
  document.title = i18n.t("common:documentTitle");
  const desc = i18n.t("common:metaDescription");
  document.querySelector('meta[name="description"]')?.setAttribute("content", desc);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", i18n.t("common:documentTitle"));
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", desc);
  document.querySelector('meta[name="twitter:title"]')?.setAttribute("content", i18n.t("common:documentTitle"));
  document.querySelector('meta[name="twitter:description"]')?.setAttribute("content", desc);
}

function setDocumentLanguage(locale: AppLocale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

function resolveStartupLocale(startupLocale?: AppLocale): AppLocale {
  if (startupLocale) return startupLocale;
  if (typeof document !== "undefined") {
    const htmlLocale = document.documentElement.lang;
    if (isAppLocale(htmlLocale)) return htmlLocale;
  }
  return getPreferredLanguage();
}

export async function initI18n(startupLocale?: AppLocale) {
  const locale = resolveStartupLocale(startupLocale);
  if (!initPromise) {
    initPromise = i18n.use(initReactI18next).init({
      resources: {
        en: {
          common: enCommon,
          auth: enAuth,
          events: enEvents,
          calendar: enCalendar,
          discover: enDiscover,
          profile: enProfile,
          settings: enSettings,
          onboarding: enOnboarding,
          createEvent: enCreateEvent,
          timezones: enTimezones,
        },
        de: {
          common: deCommon,
          auth: deAuth,
          events: deEvents,
          calendar: deCalendar,
          discover: deDiscover,
          profile: deProfile,
          settings: deSettings,
          onboarding: deOnboarding,
          createEvent: deCreateEvent,
          timezones: deTimezones,
        },
      },
      lng: locale,
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    }).then(() => undefined);
    i18n.on("initialized", updateDocumentHead);
    i18n.on("languageChanged", updateDocumentHead);
  } else {
    await initPromise;
    if (i18n.language !== locale) {
      await i18n.changeLanguage(locale);
    }
  }

  setDocumentLanguage(locale);
  updateDocumentHead();

  return initPromise;
}

async function applyLanguage(locale: AppLocale) {
  await initI18n(locale);
  if (i18n.language !== locale) {
    await i18n.changeLanguage(locale);
  }
  persistLocale(locale);
}

export function syncLanguageFromUser(preferredLanguage?: string | null) {
  if (!isAppLocale(preferredLanguage)) return;
  void applyLanguage(preferredLanguage);
}

export function changeLanguage(locale: AppLocale) {
  void applyLanguage(locale);
}

export { i18n };
export default i18n;
