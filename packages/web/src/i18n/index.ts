import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "./locales/en/common.json";
import enAuth from "./locales/en/auth.json";
import enEvents from "./locales/en/events.json";
import enCalendar from "./locales/en/calendar.json";
import enDiscover from "./locales/en/discover.json";
import enProfile from "./locales/en/profile.json";
import enSettings from "./locales/en/settings.json";
import enOnboarding from "./locales/en/onboarding.json";
import enCreateEvent from "./locales/en/createEvent.json";
import deCommon from "./locales/de/common.json";
import deAuth from "./locales/de/auth.json";
import deEvents from "./locales/de/events.json";
import deCalendar from "./locales/de/calendar.json";
import deDiscover from "./locales/de/discover.json";
import deProfile from "./locales/de/profile.json";
import deSettings from "./locales/de/settings.json";
import deOnboarding from "./locales/de/onboarding.json";
import deCreateEvent from "./locales/de/createEvent.json";

const STORAGE_KEY = "everycal_locale";

function getInitialLanguage(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "de") return stored;
  const browser = navigator.language?.toLowerCase().split("-")[0];
  return browser === "de" ? "de" : "en";
}

i18n.use(initReactI18next).init({
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
  lng: getInitialLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

/** Sync i18n language with user preference (call when user logs in). */
export function syncLanguageFromUser(preferredLanguage?: string | null) {
  if (preferredLanguage === "en" || preferredLanguage === "de") {
    i18n.changeLanguage(preferredLanguage);
    localStorage.setItem(STORAGE_KEY, preferredLanguage);
  }
}

/** Change language and persist. Call updateProfile if user is logged in. */
export function changeLanguage(locale: "en" | "de") {
  i18n.changeLanguage(locale);
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
  updateDocumentHead();
}

function updateDocumentHead() {
  document.title = i18n.t("common:documentTitle");
  const desc = i18n.t("common:metaDescription");
  document.querySelector('meta[name="description"]')?.setAttribute("content", desc);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", i18n.t("common:documentTitle"));
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", desc);
  document.querySelector('meta[name="twitter:title"]')?.setAttribute("content", i18n.t("common:documentTitle"));
  document.querySelector('meta[name="twitter:description"]')?.setAttribute("content", desc);
}

// Set initial lang attribute and document head
document.documentElement.lang = i18n.language;
i18n.on("initialized", updateDocumentHead);
i18n.on("languageChanged", updateDocumentHead);

export { STORAGE_KEY };
