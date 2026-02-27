/**
 * Server-side i18n - creates i18n instance for SSR.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "./i18n/locales/en/common.json";
import enAuth from "./i18n/locales/en/auth.json";
import enEvents from "./i18n/locales/en/events.json";
import enCalendar from "./i18n/locales/en/calendar.json";
import enDiscover from "./i18n/locales/en/discover.json";
import enProfile from "./i18n/locales/en/profile.json";
import enSettings from "./i18n/locales/en/settings.json";
import enOnboarding from "./i18n/locales/en/onboarding.json";
import enCreateEvent from "./i18n/locales/en/createEvent.json";
import deCommon from "./i18n/locales/de/common.json";
import deAuth from "./i18n/locales/de/auth.json";
import deEvents from "./i18n/locales/de/events.json";
import deCalendar from "./i18n/locales/de/calendar.json";
import deDiscover from "./i18n/locales/de/discover.json";
import deProfile from "./i18n/locales/de/profile.json";
import deSettings from "./i18n/locales/de/settings.json";
import deOnboarding from "./i18n/locales/de/onboarding.json";
import deCreateEvent from "./i18n/locales/de/createEvent.json";

const SUPPORTED_LOCALES = ["en", "de"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupported(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.includes(locale as SupportedLocale);
}

/** Parse Accept-Language header and return first supported locale, or "en". */
export function getLocaleFromRequest(request: { headers: { get: (name: string) => string | null } }): SupportedLocale {
  const acceptLang = request.headers.get("accept-language");
  if (!acceptLang) return "en";
  
  const parts = acceptLang.split(",").map((p) => {
    const [lang, q = "1"] = p.trim().split(";q=");
    return { lang: lang.trim().toLowerCase().split("-")[0], q: parseFloat(q) || 1 };
  });
  parts.sort((a, b) => b.q - a.q);
  for (const { lang } of parts) {
    if (isSupported(lang)) return lang;
  }
  return "en";
}

let serverI18nInstance: typeof i18n | null = null;

/** Create a server-side i18n instance */
export function createI18nServer(locale: SupportedLocale) {
  if (serverI18nInstance && serverI18nInstance.language === locale) {
    return serverI18nInstance;
  }
  
  const instance = i18n.createInstance();
  instance.use(initReactI18next).init({
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
      },
    },
    lng: locale,
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  
  serverI18nInstance = instance;
  return instance;
}
