import { useEffect, useMemo, useRef, useState } from "react";

type TimezoneOption = {
  tz: string;
  continent: string;
  city: string;
  abbreviation: string;
  offsetLabel: string;
  offsetMinutes: number;
  displayLabel: string;
  searchText: string;
};

const COUNTRY_ALIASES: Record<string, string[]> = {
  "Europe/London": ["united kingdom", "uk", "gb", "great britain", "britain", "england"],
  "Asia/Dubai": ["united arab emirates", "uae"],
  "Asia/Kolkata": ["india", "indian", "delhi", "in"],
  "America/New_York": ["usa", "us", "united states", "america"],
  "America/Chicago": ["usa", "us", "united states", "america"],
  "America/Denver": ["usa", "us", "united states", "america"],
  "America/Los_Angeles": ["usa", "us", "united states", "america"],
};

const CITY_ALIASES: Record<string, string[]> = {
  "Asia/Kolkata": ["delhi"],
};

function parseOffset(offsetPart: string): { label: string; minutes: number } {
  const m = offsetPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return { label: "UTC±00:00", minutes: 0 };
  const sign = m[1] === "+" ? 1 : -1;
  const hh = Number(m[2]);
  const mm = Number(m[3] || "0");
  const minutes = sign * (hh * 60 + mm);
  return {
    label: `UTC${m[1]}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    minutes,
  };
}

function timezoneShortName(tz: string, date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")
    ?.value || "";
}

function getAbbreviation(tz: string, now: Date): string {
  const nowShort = timezoneShortName(tz, now);
  if (nowShort && !/^(GMT|UTC)/i.test(nowShort)) return nowShort;

  const winterShort = timezoneShortName(tz, new Date(Date.UTC(2024, 0, 15)));
  if (winterShort && !/^(GMT|UTC)/i.test(winterShort)) return winterShort;

  const summerShort = timezoneShortName(tz, new Date(Date.UTC(2024, 6, 15)));
  if (summerShort && !/^(GMT|UTC)/i.test(summerShort)) return summerShort;

  return nowShort || winterShort || summerShort || "GMT";
}

function collectNames(tz: string): string[] {
  const dates = [new Date(Date.UTC(2024, 0, 15)), new Date(Date.UTC(2024, 6, 15))];
  const styles: Intl.DateTimeFormatOptions["timeZoneName"][] = ["short", "long", "shortGeneric", "longGeneric"];
  const out = new Set<string>();
  for (const d of dates) {
    for (const style of styles) {
      try {
        const val = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: style })
          .formatToParts(d)
          .find((p) => p.type === "timeZoneName")?.value;
        if (val) out.add(val);
      } catch {
        // ignore
      }
    }
  }
  return [...out];
}

function chooseCandidateTimezones(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") || [];
    // Prune noisy aliases/legacy names and deep paths like America/Indiana/Indianapolis.
    const filtered = all.filter((tz) => {
      if (tz.startsWith("Etc/") || tz.startsWith("US/") || tz.startsWith("Canada/")) return false;
      const depth = tz.split("/").length;
      return depth <= 2;
    });
    return filtered.length > 0 ? filtered : ["Europe/Vienna", "Europe/London", "Asia/Kolkata", "America/New_York"];
  } catch {
    return [
      "Europe/Vienna",
      "Europe/Berlin",
      "Europe/London",
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Asia/Tokyo",
      "Asia/Dubai",
      "Australia/Sydney",
    ];
  }
}

function toOption(tz: string, now: Date): TimezoneOption {
  const parts = tz.split("/");
  const continent = parts[0] || "";
  const city = (parts[parts.length - 1] || tz).replace(/_/g, " ");

  const shortOffset = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")
    ?.value || "GMT+0";
  const { label: offsetLabel, minutes: offsetMinutes } = parseOffset(shortOffset);
  const abbreviation = getAbbreviation(tz, now);
  const names = collectNames(tz);

  const searchText = [
    tz,
    city,
    continent,
    abbreviation,
    offsetLabel,
    ...names,
    ...(COUNTRY_ALIASES[tz] || []),
    ...(CITY_ALIASES[tz] || []),
  ].join(" ").toLowerCase();

  return {
    tz,
    continent,
    city,
    abbreviation,
    offsetLabel,
    offsetMinutes,
    displayLabel: `${offsetLabel} ${city} · ${continent}`,
    searchText,
  };
}

export function TimezonePicker({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const now = useMemo(() => new Date(), []);
  const options = useMemo(() => {
    return chooseCandidateTimezones()
      .map((tz) => toOption(tz, now))
      .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city));
  }, [now]);

  const selected = useMemo(() => options.find((o) => o.tz === value), [options, value]);

  const [query, setQuery] = useState(selected?.displayLabel || value || "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const justSelectedRef = useRef(false);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setQuery(selected?.displayLabel || value || "");
  }, [selected?.displayLabel, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 60);
    return options.filter((o) => o.searchText.includes(q)).slice(0, 60);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const el = itemRefs.current[highlight];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const apply = (tz: string) => {
    justSelectedRef.current = true;
    onChange(tz);
    const match = options.find((o) => o.tz === tz);
    if (match) setQuery(match.displayLabel);
    setOpen(false);
  };

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <input
        id={id}
        value={query}
        onFocus={() => {
          setQuery("");
          setOpen(true);
          const idx = options.findIndex((o) => o.tz === value);
          setHighlight(idx >= 0 ? idx : 0);
        }}
        onBlur={() => {
          setTimeout(() => {
            if (!justSelectedRef.current) {
              setQuery(selected?.displayLabel || value || "");
            }
            justSelectedRef.current = false;
            setOpen(false);
          }, 120);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            setOpen(true);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
            return;
          }
          if (e.key === "Enter") {
            if (open && filtered[highlight]) {
              e.preventDefault();
              apply(filtered[highlight].tz);
            }
            return;
          }
          if (e.key === "Escape") {
            setQuery(selected?.displayLabel || value || "");
            setOpen(false);
          }
        }}
        placeholder={placeholder || "Search timezone, city, country, offset (e.g. CEST, UK, UAE, UTC+1)"}
        autoComplete="off"
      />

      {open && filtered.length > 0 && (
        <div className="venue-dropdown timezone-dropdown" role="listbox" aria-label="Timezone suggestions">
          {filtered.map((opt, idx) => (
            <button
              key={opt.tz}
              ref={(el) => { itemRefs.current[idx] = el; }}
              type="button"
              className={`venue-dropdown-item timezone-item ${idx === highlight ? "timezone-item-active" : ""}`}
              onMouseEnter={() => setHighlight(idx)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => apply(opt.tz)}
            >
              <span className="timezone-item-main">
                <strong>{opt.offsetLabel}</strong>
                <span>{opt.city}</span>
                <span className="timezone-item-muted">{opt.continent}</span>
              </span>
              <span className="timezone-item-abbr">{opt.abbreviation}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
