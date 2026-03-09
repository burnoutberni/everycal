import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

type TimezonePickerProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  referenceDateMs?: number;
  allowSystemOption?: boolean;
  systemValue?: string;
  systemLabel?: string;
};

type TimezoneOption = {
  tz: string;
  continent: string;
  country: string;
  city: string;
  offsetLabel: string;
  offsetMinutes: number;
  abbreviation: string;
  displayLabel: string;
  searchText: string;
};

const FALLBACK_TIMEZONES = [
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const POPULAR_TIMEZONES = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Halifax",
  "America/St_Johns",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Helsinki",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const MAX_VISIBLE_OPTIONS = 60;
const BLUR_CLOSE_DELAY_MS = 120;
const SAMPLE_WINTER_DATE = new Date(Date.UTC(2024, 0, 15));
const SAMPLE_SUMMER_DATE = new Date(Date.UTC(2024, 6, 15));

const optionCacheByLocaleAndDate = new Map<string, Map<string, TimezoneOption>>();
const displayNamesCache = new Map<string, Intl.DisplayNames | null>();

const CONTINENT_TRANSLATION_KEYS: Record<string, string> = {
  Africa: "Africa",
  America: "North and South America",
  Antarctica: "Antarctica",
  Arctic: "Arctic",
  Asia: "Asia",
  Atlantic: "Atlantic",
  Australia: "Australia",
  Europe: "Europe",
  Indian: "Indian Ocean",
  Pacific: "Pacific",
};

const COUNTRY_CODE_BY_TIMEZONE: Record<string, string> = {
  "Pacific/Honolulu": "US",
  "America/Anchorage": "US",
  "America/Los_Angeles": "US",
  "America/Denver": "US",
  "America/Chicago": "US",
  "America/New_York": "US",
  "America/Halifax": "CA",
  "America/St_Johns": "CA",
  "Europe/London": "GB",
  "Europe/Berlin": "DE",
  "Europe/Helsinki": "FI",
  "Asia/Dubai": "AE",
  "Asia/Kolkata": "IN",
  "Asia/Bangkok": "TH",
  "Asia/Tokyo": "JP",
  "Australia/Sydney": "AU",
  "Pacific/Auckland": "NZ",
};

const FALLBACK_ABBREVIATIONS: Record<string, { standard: string; daylight?: string }> = {
  "Pacific/Honolulu": { standard: "HST" },
  "America/Anchorage": { standard: "AKST", daylight: "AKDT" },
  "America/Los_Angeles": { standard: "PST", daylight: "PDT" },
  "America/Denver": { standard: "MST", daylight: "MDT" },
  "America/Chicago": { standard: "CST", daylight: "CDT" },
  "America/New_York": { standard: "EST", daylight: "EDT" },
  "America/Halifax": { standard: "AST", daylight: "ADT" },
  "America/St_Johns": { standard: "NST", daylight: "NDT" },
  "Europe/London": { standard: "GMT", daylight: "BST" },
  "Europe/Berlin": { standard: "CET", daylight: "CEST" },
  "Europe/Helsinki": { standard: "EET", daylight: "EEST" },
  "Asia/Dubai": { standard: "GST" },
  "Asia/Kolkata": { standard: "IST" },
  "Asia/Bangkok": { standard: "ICT" },
  "Asia/Singapore": { standard: "SGT" },
  "Asia/Tokyo": { standard: "JST" },
  "Australia/Sydney": { standard: "AEST", daylight: "AEDT" },
  "Pacific/Auckland": { standard: "NZST", daylight: "NZDT" },
};

function toCanonicalLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] || "en";
  } catch {
    return "en";
  }
}

function availableTimezones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") || [];
    return zones.length > 0 ? zones : FALLBACK_TIMEZONES;
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

function readZoneNamePart(
  timeZone: string,
  date: Date,
  locale: string,
  style: Intl.DateTimeFormatOptions["timeZoneName"],
): string {
  return (
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value || ""
  );
}

function getDisplayNames(locale: string): Intl.DisplayNames | null {
  const cached = displayNamesCache.get(locale);
  if (cached !== undefined) return cached;

  try {
    const created = new Intl.DisplayNames(locale, { type: "region" });
    displayNamesCache.set(locale, created);
    return created;
  } catch {
    displayNamesCache.set(locale, null);
    return null;
  }
}

function parseOffset(offsetRaw: string): { label: string; minutes: number } {
  const match = offsetRaw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return { label: "UTC+00:00", minutes: 0 };

  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutesPart = Number(match[3] || "0");

  return {
    label: `UTC${match[1]}${String(hours).padStart(2, "0")}:${String(minutesPart).padStart(2, "0")}`,
    minutes: sign * (hours * 60 + minutesPart),
  };
}

function offsetMinutesAt(timeZone: string, date: Date, locale: string): number {
  const shortOffset = readZoneNamePart(timeZone, date, locale, "shortOffset") || "GMT+0";
  return parseOffset(shortOffset).minutes;
}

function prefersDaylightAbbreviation(timeZone: string, now: Date, locale: string): boolean {
  const nowOffset = offsetMinutesAt(timeZone, now, locale);
  const winterOffset = offsetMinutesAt(timeZone, SAMPLE_WINTER_DATE, locale);
  const summerOffset = offsetMinutesAt(timeZone, SAMPLE_SUMMER_DATE, locale);
  if (winterOffset === summerOffset) return false;
  if (nowOffset === summerOffset) return true;
  if (nowOffset === winterOffset) return false;
  return summerOffset > winterOffset;
}

function normalizeAbbreviation(raw: string): string {
  if (!raw) return "GMT";
  if (/^(GMT|UTC)/i.test(raw)) return "GMT";
  return raw;
}

function runtimeAbbreviationCandidates(timeZone: string, locale: string, now: Date): string[] {
  const values = [
    readZoneNamePart(timeZone, now, locale, "short"),
    readZoneNamePart(timeZone, SAMPLE_WINTER_DATE, locale, "short"),
    readZoneNamePart(timeZone, SAMPLE_SUMMER_DATE, locale, "short"),
    readZoneNamePart(timeZone, now, "en", "short"),
    readZoneNamePart(timeZone, SAMPLE_WINTER_DATE, "en", "short"),
    readZoneNamePart(timeZone, SAMPLE_SUMMER_DATE, "en", "short"),
  ];

  return values.map((value) => normalizeAbbreviation(value)).filter((value) => value !== "GMT");
}

function localizedAbbreviation(
  timeZone: string,
  now: Date,
  locale: string,
  translate: (key: string, defaultValue: string) => string,
): string {
  const daylight = prefersDaylightAbbreviation(timeZone, now, locale);
  const keySuffix = daylight ? "daylight" : "standard";
  const timeZoneKey = timeZone.replace(/\//g, "_");
  const fallbackByZone = FALLBACK_ABBREVIATIONS[timeZone];
  const runtimeFallback = runtimeAbbreviationCandidates(timeZone, locale, now)[0] || "GMT";
  const fallback =
    (daylight ? fallbackByZone?.daylight || fallbackByZone?.standard : fallbackByZone?.standard || fallbackByZone?.daylight) ||
    runtimeFallback;

  return translate(`timezones:abbreviations.${timeZoneKey}.${keySuffix}`, fallback);
}

function localizedCity(timeZone: string, fallbackCity: string, translate: (key: string, defaultValue: string) => string): string {
  const key = timeZone.replace(/\//g, "_");
  return translate(`timezones:cities.${key}`, fallbackCity);
}

function localizedContinent(continent: string, translate: (key: string, defaultValue: string) => string): string {
  return translate(`timezones:continents.${continent}`, CONTINENT_TRANSLATION_KEYS[continent] || continent);
}

function localizedCountry(timeZone: string, locale: string): string {
  const code = COUNTRY_CODE_BY_TIMEZONE[timeZone];
  if (!code) return "";
  return getDisplayNames(locale)?.of(code) || code;
}

function dateCacheKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function compareOptions(a: TimezoneOption, b: TimezoneOption, locale: string): number {
  return a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city, locale);
}

function buildTimezoneOption(
  timeZone: string,
  now: Date,
  locale: string,
  translate: (key: string, defaultValue: string) => string,
): TimezoneOption {
  const parts = timeZone.split("/");
  const continentRaw = parts[0] || timeZone;
  const cityRaw = (parts[parts.length - 1] || timeZone).replace(/_/g, " ");

  const continent = localizedContinent(continentRaw, translate);
  const country = localizedCountry(timeZone, locale);
  const city = localizedCity(timeZone, cityRaw, translate);

  const shortOffset = readZoneNamePart(timeZone, now, locale, "shortOffset") || "GMT+0";
  const { label: offsetLabel, minutes: offsetMinutes } = parseOffset(shortOffset);
  const abbreviation = localizedAbbreviation(timeZone, now, locale, translate);

  const searchText = [
    timeZone,
    continentRaw,
    city,
    cityRaw,
    country,
    abbreviation,
    offsetLabel,
    readZoneNamePart(timeZone, now, locale, "long"),
    readZoneNamePart(timeZone, now, locale, "longGeneric"),
    readZoneNamePart(timeZone, now, locale, "shortGeneric"),
  ]
    .join(" ")
    .toLowerCase();

  return {
    tz: timeZone,
    continent,
    country,
    city,
    offsetLabel,
    offsetMinutes,
    abbreviation,
    displayLabel: `${offsetLabel} ${city} ${abbreviation}`,
    searchText,
  };
}

function optionForTimezone(
  timeZone: string,
  referenceDate: Date,
  locale: string,
  cacheKey: string,
  translate: (key: string, defaultValue: string) => string,
): TimezoneOption | undefined {
  const localeAndDateKey = `${locale}::${cacheKey}`;
  let cache = optionCacheByLocaleAndDate.get(localeAndDateKey);
  if (!cache) {
    cache = new Map<string, TimezoneOption>();
    optionCacheByLocaleAndDate.set(localeAndDateKey, cache);
  }

  const cached = cache.get(timeZone);
  if (cached) return cached;

  try {
    const created = buildTimezoneOption(timeZone, referenceDate, locale, translate);
    cache.set(timeZone, created);
    return created;
  } catch {
    return undefined;
  }
}

function uniqueSortedOptions(values: TimezoneOption[], locale: string): TimezoneOption[] {
  const deduped = new Map<string, TimezoneOption>();
  for (const option of values) deduped.set(option.tz, option);
  return [...deduped.values()].sort((a, b) => compareOptions(a, b, locale));
}

export function TimezonePicker({
  id,
  value,
  onChange,
  placeholder,
  referenceDateMs,
  allowSystemOption = false,
  systemValue = "system",
  systemLabel,
}: TimezonePickerProps) {
  const { t, i18n } = useTranslation(["common", "timezones"]);

  const locale = useMemo(() => toCanonicalLocale(i18n.language || "en"), [i18n.language]);
  const now = useMemo(() => new Date(), []);
  const allTimezones = useMemo(() => availableTimezones(), []);
  const referenceDate = useMemo(() => {
    if (typeof referenceDateMs === "number" && Number.isFinite(referenceDateMs)) {
      return new Date(referenceDateMs);
    }
    return now;
  }, [referenceDateMs, now]);
  const referenceDateKey = useMemo(() => dateCacheKey(referenceDate), [referenceDate]);
  const translate = useMemo(
    () => (key: string, defaultValue: string) => t(key, { defaultValue }),
    [t],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [hasTypedSearch, setHasTypedSearch] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const justSelectedRef = useRef(false);

  const selectedOption = useMemo(() => {
    if (!value || (allowSystemOption && value === systemValue)) return undefined;
    return optionForTimezone(value, referenceDate, locale, referenceDateKey, translate);
  }, [allowSystemOption, locale, referenceDate, referenceDateKey, systemValue, translate, value]);

  const systemOption = useMemo(() => {
    if (!allowSystemOption) return undefined;
    const runtimeTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!runtimeTimeZone) return undefined;
    const runtimeOption = optionForTimezone(runtimeTimeZone, referenceDate, locale, referenceDateKey, translate);
    if (!runtimeOption) return undefined;
    const label = systemLabel || t("systemTimeZone");
    return {
      ...runtimeOption,
      tz: systemValue,
      city: label,
      displayLabel: `${label} · ${runtimeOption.offsetLabel} ${runtimeOption.abbreviation}`,
      searchText: `${label} ${runtimeOption.searchText}`.toLowerCase(),
    } satisfies TimezoneOption;
  }, [allowSystemOption, locale, referenceDate, referenceDateKey, systemLabel, systemValue, t, translate]);

  const isSystemSelected = allowSystemOption && value === systemValue && !!systemOption;

  const defaultOptions = useMemo(() => {
    const local = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const candidates = local ? [local, ...POPULAR_TIMEZONES] : POPULAR_TIMEZONES;

    const options = candidates
      .map((tz) => optionForTimezone(tz, referenceDate, locale, referenceDateKey, translate))
      .filter((option): option is TimezoneOption => !!option);

    if (selectedOption) options.push(selectedOption);
    const sorted = uniqueSortedOptions(options, locale).filter((option) => option.tz !== systemValue);
    return systemOption ? [systemOption, ...sorted] : sorted;
  }, [locale, referenceDate, referenceDateKey, selectedOption, systemOption, systemValue, translate]);

  const fullSearchOptions = useMemo(() => {
    if (!hasTypedSearch) return [];

    return allTimezones
      .map((tz) => optionForTimezone(tz, referenceDate, locale, referenceDateKey, translate))
      .filter((option): option is TimezoneOption => !!option)
      .sort((a, b) => compareOptions(a, b, locale));
  }, [allTimezones, hasTypedSearch, locale, referenceDate, referenceDateKey, translate]);

  useEffect(() => {
    setQuery(selectedOption?.displayLabel || (isSystemSelected ? systemOption?.displayLabel : value) || "");
  }, [isSystemSelected, selectedOption, systemOption?.displayLabel, value]);

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const sourceBase = (normalized ? fullSearchOptions : defaultOptions).filter((option) => option.tz !== systemValue);
    const source = normalized ? sourceBase.filter((option) => option.searchText.includes(normalized)) : sourceBase;
    const withPinnedSystem = systemOption ? [systemOption, ...source] : source;

    return withPinnedSystem.slice(0, MAX_VISIBLE_OPTIONS);
  }, [defaultOptions, fullSearchOptions, query, systemOption, systemValue]);

  const showSelectionOverlay = !open && (!!selectedOption || isSystemSelected);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const item = itemRefs.current[highlight];
    if (!list || !item) return;

    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;

    if (top < viewTop) {
      list.scrollTop = top;
      return;
    }

    if (bottom > viewBottom) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [highlight, open]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const selectTimezone = (timeZone: string) => {
    justSelectedRef.current = true;
    onChange(timeZone);
    if (allowSystemOption && timeZone === systemValue && systemOption) {
      setQuery(systemOption.displayLabel);
      setOpen(false);
      return;
    }
    const next = optionForTimezone(timeZone, referenceDate, locale, referenceDateKey, translate);
    setQuery(next?.displayLabel || timeZone);
    setOpen(false);
  };

  const onFocus = () => {
    setOpen(true);
    setQuery("");
    const selectedIndex = defaultOptions.findIndex((option) => option.tz === value);
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  };

  const onBlur = () => {
    setTimeout(() => {
        if (!justSelectedRef.current) {
          setQuery(selectedOption?.displayLabel || (isSystemSelected ? systemOption?.displayLabel : value) || "");
        }

      justSelectedRef.current = false;
      setOpen(false);
    }, BLUR_CLOSE_DELAY_MS);
  };

  const onInputChange = (next: string) => {
    setQuery(next);
    setOpen(true);
    setHighlight(0);
    if (next.trim()) setHasTypedSearch(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setOpen(true);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      const selected = filteredOptions[highlight];
      if (selected) {
        event.preventDefault();
        selectTimezone(selected.tz);
      }
      return;
    }

    if (event.key === "Escape") {
      setQuery(selectedOption?.displayLabel || (isSystemSelected ? systemOption?.displayLabel : value) || "");
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <input
        id={id}
        value={query}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder || t("common:timezoneSearchPlaceholder")}
        autoComplete="off"
        style={showSelectionOverlay ? { color: "transparent", caretColor: "transparent" } : undefined}
      />

      {showSelectionOverlay && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            paddingLeft: 12,
            paddingRight: 12,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <strong>{(isSystemSelected ? systemOption : selectedOption)?.offsetLabel}</strong>
            <span>{(isSystemSelected ? systemOption : selectedOption)?.city}</span>
          </span>
          <span className="timezone-item-abbr">{(isSystemSelected ? systemOption : selectedOption)?.abbreviation}</span>
        </div>
      )}

      {open && filteredOptions.length > 0 && (
        <div
          ref={listRef}
          className="venue-dropdown timezone-dropdown"
          role="listbox"
          aria-label={t("common:timezoneSuggestionsAria")}
        >
          {filteredOptions.map((option, index) => (
            <button
              key={option.tz}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              className={`venue-dropdown-item timezone-item ${option.tz === systemValue ? "dropdown-pinned-item " : ""}${index === highlight ? "timezone-item-active" : ""}`}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectTimezone(option.tz)}
            >
              <span className="timezone-item-main">
                <strong>{option.offsetLabel}</strong>
                <span>{option.city}</span>
              </span>
              <span className="timezone-item-abbr">{option.abbreviation}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
