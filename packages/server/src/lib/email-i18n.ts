/**
 * Email-specific i18n. Loads message files for email templates.
 */

import en from "../i18n/emails/en.json";
import de from "../i18n/emails/de.json";

const SUPPORTED = ["en", "de"] as const;
type Locale = (typeof SUPPORTED)[number];

const messages: Record<Locale, Record<string, unknown>> = { en, de };

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

export function emailT(
  locale: string,
  key: string,
  params?: Record<string, string | number>
): string {
  const loc = SUPPORTED.includes(locale as Locale) ? (locale as Locale) : "en";
  let str =
    getNested(messages[loc] as Record<string, unknown>, key) ??
    getNested(messages.en as Record<string, unknown>, key) ??
    key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return str;
}
