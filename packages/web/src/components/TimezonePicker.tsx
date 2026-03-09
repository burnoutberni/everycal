import { useEffect, useMemo, useRef, useState } from "react";

const COUNTRY_ALIAS_BY_CITY: Record<string, string[]> = {
  london: ["united kingdom", "uk", "gb", "great britain", "britain", "england"],
  belfast: ["united kingdom", "uk", "gb", "great britain", "britain"],
  dubai: ["united arab emirates", "uae"],
  abu: ["united arab emirates", "uae"],
  new: ["usa", "us", "united states", "america"],
  los: ["usa", "us", "united states", "america"],
  chicago: ["usa", "us", "united states", "america"],
  denver: ["usa", "us", "united states", "america"],
  phoenix: ["usa", "us", "united states", "america"],
  toronto: ["canada", "ca"],
  vancouver: ["canada", "ca"],
  vienna: ["austria", "at"],
  berlin: ["germany", "de"],
  paris: ["france", "fr"],
  madrid: ["spain", "es"],
  rome: ["italy", "it"],
  tokyo: ["japan", "jp"],
  singapore: ["singapore", "sg"],
  sydney: ["australia", "au"],
  auckland: ["new zealand", "nz"],
};

function safeSupportedTimezones(): string[] {
  try {
    const values = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone");
    if (values && values.length > 0) return values;
  } catch {
    // ignore
  }
  return [
    "Europe/Vienna",
    "Europe/Berlin",
    "Europe/London",
    "America/New_York",
    "America/Los_Angeles",
    "America/Denver",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Australia/Sydney",
  ];
}

function parseOffsetToUtcLabel(offsetPart: string): string {
  const m = offsetPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return "UTC±00:00";
  const sign = m[1];
  const hh = String(Number(m[2])).padStart(2, "0");
  const mm = String(Number(m[3] || "0")).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

function collectNames(tz: string): string[] {
  const dates = [new Date(Date.UTC(2024, 0, 15)), new Date(Date.UTC(2024, 6, 15))];
  const styles: Intl.DateTimeFormatOptions["timeZoneName"][] = ["short", "long", "shortGeneric", "longGeneric"];
  const out = new Set<string>();
  for (const d of dates) {
    for (const style of styles) {
      try {
        const val = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: style })
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

function countryAliases(city: string): string[] {
  const key = city.toLowerCase().split(" ")[0] || city.toLowerCase();
  return COUNTRY_ALIAS_BY_CITY[key] || [];
}

function timezoneMeta(tz: string, now: Date) {
  const parts = tz.split("/");
  const continent = parts[0] || "";
  const cityRaw = parts[parts.length - 1] || tz;
  const city = cityRaw.replace(/_/g, " ");

  const shortOffset = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")
    ?.value || "GMT+0";
  const abbreviation = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")
    ?.value || "GMT";

  const names = collectNames(tz);
  const offsetLabel = parseOffsetToUtcLabel(shortOffset);
  const displayLabel = `${offsetLabel} ${city} · ${continent}`;

  return {
    tz,
    continent,
    city,
    abbreviation,
    offsetLabel,
    displayLabel,
    searchText: [tz, city, continent, abbreviation, offsetLabel, ...names, ...countryAliases(city)].join(" ").toLowerCase(),
  };
}

function pinSelectedFirst<T extends { tz: string }>(list: T[], selectedTz?: string): T[] {
  if (!selectedTz) return list;
  const idx = list.findIndex((x) => x.tz === selectedTz);
  if (idx <= 0) return list;
  return [list[idx], ...list.slice(0, idx), ...list.slice(idx + 1)];
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
  const options = useMemo(() => safeSupportedTimezones().map((tz) => timezoneMeta(tz, now)), [now]);
  const selected = useMemo(() => options.find((o) => o.tz === value), [options, value]);

  const [query, setQuery] = useState(selected?.displayLabel || value || "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const justSelectedRef = useRef(false);

  useEffect(() => {
    setQuery(selected?.displayLabel || value || "");
  }, [selected?.displayLabel, value]);

  const ordered = useMemo(() => pinSelectedFirst(options, value), [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered.slice(0, 60);
    const matches = ordered.filter((o) => o.searchText.includes(q));
    if (selected && !matches.some((m) => m.tz === selected.tz)) {
      return [selected, ...matches].slice(0, 60);
    }
    return matches.slice(0, 60);
  }, [ordered, query, selected]);

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
          setHighlight(0);
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
        placeholder={placeholder || "Search timezone, city, country, offset (e.g. GMT, UK, USA, UTC+1)"}
        autoComplete="off"
      />

      {open && filtered.length > 0 && (
        <div className="venue-dropdown timezone-dropdown" role="listbox" aria-label="Timezone suggestions">
          {filtered.map((opt, idx) => (
            <button
              key={opt.tz}
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
              <span className="venue-dropdown-addr">{opt.abbreviation}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
