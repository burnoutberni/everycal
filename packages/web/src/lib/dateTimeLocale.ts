import type { User } from "./api";

export const SYSTEM_TIMEZONE = "system";
export const SYSTEM_DATE_TIME_LOCALE = "system";

function browserLocale(): string {
  const runtimeLocale = Intl.DateTimeFormat().resolvedOptions().locale || "en-GB";
  try {
    return Intl.getCanonicalLocales(runtimeLocale)[0] || "en-GB";
  } catch {
    return "en-GB";
  }
}

export function browserTimezone(): string {
  const runtimeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!runtimeTimeZone) return "Europe/Vienna";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: runtimeTimeZone });
    return runtimeTimeZone;
  } catch {
    return "Europe/Vienna";
  }
}

export function usesSystemTimezone(user: Pick<User, "timezone"> | null | undefined): boolean {
  return !user?.timezone || user.timezone === SYSTEM_TIMEZONE;
}

export function usesSystemDateTimeLocale(user: Pick<User, "dateTimeLocale"> | null | undefined): boolean {
  return !user?.dateTimeLocale || user.dateTimeLocale === SYSTEM_DATE_TIME_LOCALE;
}

export function resolveUserTimezone(user: Pick<User, "timezone"> | null | undefined): string {
  if (usesSystemTimezone(user)) return browserTimezone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: user!.timezone! });
    return user!.timezone!;
  } catch {
    return browserTimezone();
  }
}

export type CountryLocaleOption = {
  regionCode: string;
  countryName: string;
  locale: string;
  searchText: string;
};

const COUNTRY_SEARCH_ALIASES: Record<string, string[]> = {
  US: ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america", "vereinigte staaten"],
  GB: ["uk", "u.k.", "great britain", "britain", "england", "vereinigtes konigreich", "vereinigtes königreich", "grossbritannien", "großbritannien"],
  AE: ["uae", "u.a.e.", "united arab emirates", "vereinigte arabische emirate", "vae"],
  DE: ["de", "deutschland", "germany"],
  AT: ["at", "osterreich", "österreich", "austria"],
  CH: ["ch", "schweiz", "switzerland"],
  NL: ["holland", "netherlands", "niederlande"],
  CZ: ["czechia", "czech republic", "tschechien"],
  KR: ["south korea", "korea", "sudkorea", "südkorea"],
};

const SUNDAY_FIRST_REGIONS = new Set([
  "US", "CA", "AU", "NZ", "JP", "KR", "CN", "PH", "TH", "TW", "HK", "MO", "MY", "SG", "IN", "ID", "ZA", "MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC",
]);

const SATURDAY_FIRST_REGIONS = new Set(["AE", "AF", "BH", "DJ", "DZ", "EG", "IQ", "IR", "JO", "KW", "LY", "OM", "QA", "SA", "SD", "SY", "YE"]);

export function resolveDateTimeLocale(user: Pick<User, "dateTimeLocale"> | null | undefined, fallbackLocale: string): string {
  if (usesSystemDateTimeLocale(user)) {
    return browserLocale();
  }
  const candidate = user?.dateTimeLocale || fallbackLocale || "en-GB";
  try {
    return Intl.getCanonicalLocales(candidate)[0] || "en-GB";
  } catch {
    return "en-GB";
  }
}

export function localeRegion(locale: string): string | undefined {
  try {
    const withRegion = new Intl.Locale(locale).maximize() as Intl.Locale & { region?: string };
    return withRegion.region;
  } catch {
    return undefined;
  }
}

function countryCodesFromBrowser(): string[] {
  const isoCodes = [
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
    "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
    "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ",
    "DE", "DJ", "DK", "DM", "DO", "DZ",
    "EC", "EE", "EG", "EH", "ER", "ES", "ET",
    "FI", "FJ", "FK", "FM", "FO", "FR",
    "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
    "HK", "HM", "HN", "HR", "HT", "HU",
    "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT",
    "JE", "JM", "JO", "JP",
    "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ",
    "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
    "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
    "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
    "OM",
    "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
    "QA",
    "RE", "RO", "RS", "RU", "RW",
    "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
    "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
    "UA", "UG", "UM", "US", "UY", "UZ",
    "VA", "VC", "VE", "VG", "VI", "VN", "VU",
    "WF", "WS",
    "YE", "YT",
    "ZA", "ZM", "ZW",
  ];

  return isoCodes;
}

export function buildCountryLocaleOptions(displayLocale: string, languageHint: string): CountryLocaleOption[] {
  const displayNames = new Intl.DisplayNames(displayLocale, { type: "region" });
  const lang = languageHint.toLowerCase().split(/[-_]/)[0] || "en";

  const localeForRegion = (regionCode: string): string => {
    const candidates = [
      `und-${regionCode}`,
      `${lang}-${regionCode}`,
      `${displayLocale.split(/[-_]/)[0]}-${regionCode}`,
      "en-GB",
    ];

    for (const candidate of candidates) {
      try {
        const maximized = new Intl.Locale(candidate).maximize().toString();
        const canonical = Intl.getCanonicalLocales(maximized)[0] || Intl.getCanonicalLocales(candidate)[0];
        if (!canonical) continue;
        new Intl.DateTimeFormat(canonical, { dateStyle: "short", timeStyle: "short" });
        return canonical;
      } catch {
        // try next candidate
      }
    }

    return "en-GB";
  };

  return countryCodesFromBrowser()
    .map((regionCode) => {
      const countryName = displayNames.of(regionCode) || regionCode;
      const locale = localeForRegion(regionCode);
      return {
        regionCode,
        countryName,
        locale,
        searchText: `${countryName} ${regionCode} ${locale} ${(COUNTRY_SEARCH_ALIASES[regionCode] || []).join(" ")}`.toLowerCase(),
      };
    })
    .sort((a, b) => a.countryName.localeCompare(b.countryName, displayLocale));
}

export function localeWeekStart(locale: string): number {
  try {
    const localeWithWeekInfo = new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay?: number } };
    const firstDay = localeWithWeekInfo.weekInfo?.firstDay;
    if (firstDay != null) return firstDay % 7;
  } catch {
    // continue to region fallback
  }

  const region = localeRegion(locale);
  if (region && SATURDAY_FIRST_REGIONS.has(region)) return 6;
  if (region && SUNDAY_FIRST_REGIONS.has(region)) return 0;
  return 1;
}
