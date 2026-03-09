import { useEffect, useMemo, useRef, useState } from "react";

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

function timezoneMeta(tz: string, now: Date) {
  const parts = tz.split("/");
  const continent = parts[0] || "";
  const cityRaw = parts[parts.length - 1] || tz;
  const city = cityRaw.replace(/_/g, " ");

  const shortParts = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")
    ?.value || "GMT+0";
  const shortName = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")
    ?.value || "";
  const longName = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "longGeneric" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")
    ?.value || "";

  const offsetLabel = parseOffsetToUtcLabel(shortParts);
  const displayLabel = `${offsetLabel} ${city} · ${continent}`;

  return {
    tz,
    continent,
    city,
    shortName,
    longName,
    offsetLabel,
    displayLabel,
    searchText: `${tz} ${city} ${continent} ${shortName} ${longName} ${offsetLabel}`.toLowerCase(),
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
  const options = useMemo(() => safeSupportedTimezones().map((tz) => timezoneMeta(tz, now)), [now]);
  const selected = useMemo(() => options.find((o) => o.tz === value), [options, value]);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(selected?.displayLabel || value || "");
  }, [selected?.displayLabel, value]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 40);
    return options.filter((o) => o.searchText.includes(q)).slice(0, 60);
  }, [options, query]);

  const apply = (tz: string) => {
    onChange(tz);
    const match = options.find((o) => o.tz === tz);
    if (match) setQuery(match.displayLabel);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <input
        id={id}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
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
              return;
            }
            const exact = options.find((o) => o.tz.toLowerCase() === query.trim().toLowerCase());
            if (exact) apply(exact.tz);
            return;
          }
          if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder || "Search timezone, city, offset (e.g. CET, UTC+1, Vienna)"}
        autoComplete="off"
      />

      {selected && (
        <div className="timezone-preview">
          <span className="timezone-preview-offset">{selected.offsetLabel}</span>
          <span className="timezone-preview-city">{selected.city}</span>
          <span className="timezone-preview-continent">{selected.continent}</span>
          <span className="timezone-preview-now">Now: {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: selected.tz })}</span>
        </div>
      )}

      {open && filtered.length > 0 && (
        <div className="venue-dropdown timezone-dropdown" role="listbox" aria-label="Timezone suggestions">
          {filtered.map((opt, idx) => (
            <button
              key={opt.tz}
              type="button"
              className={`venue-dropdown-item timezone-item ${idx === highlight ? "timezone-item-active" : ""}`}
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => apply(opt.tz)}
            >
              <span className="timezone-item-main">
                <strong>{opt.offsetLabel}</strong>
                <span>{opt.city}</span>
                <span className="timezone-item-muted">{opt.continent}</span>
              </span>
              <span className="venue-dropdown-addr">{opt.longName || opt.shortName || opt.tz}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
