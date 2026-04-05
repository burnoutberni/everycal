import { getVtimezoneComponent } from "@touch4it/ical-timezones";
import { EveryCalEvent, type TimezoneQuality } from "./event.js";

export interface ToICalOptions {
  tentative?: boolean;
  canceled?: boolean;
}

export interface ToICalendarOptions {
  prodId?: string;
  calendarName?: string;
}

export type CalendarEntry = EveryCalEvent | { event: EveryCalEvent; options?: ToICalOptions };

interface ParsedProperty {
  name: string;
  rawKey: string;
  params: Record<string, string>;
  value: string;
}

const ISO_HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export function toICalendar(entries: CalendarEntry[], options?: ToICalendarOptions): string {
  const normalized = entries.map((entry) => ("event" in entry ? entry : { event: entry }));
  const tzids = new Set<string>();

  for (const { event } of normalized) {
    const tzid = getEventTzidForExport(event);
    if (tzid) tzids.add(tzid);
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options?.prodId || "-//EveryCal//Calendar//EN"}`,
  ];
  if (options?.calendarName) lines.push(`X-WR-CALNAME:${escapeICalText(options.calendarName)}`);

  for (const tzid of tzids) {
    const component = getVtimezoneComponent(tzid);
    if (component) lines.push(...component.trim().split(/\r?\n/));
  }

  for (const { event, options: eventOptions } of normalized) {
    lines.push(...toICal(event, eventOptions).split("\r\n"));
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function toICal(event: EveryCalEvent, options?: ToICalOptions): string {
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${event.id}`,
    `DTSTAMP:${toUtcICalDate(event.updatedAt)}`,
  ];

  const dtStart = buildDateLine("DTSTART", event, true);
  if (dtStart) lines.push(dtStart);
  const dtEnd = buildDateLine("DTEND", event, false);
  if (dtEnd) lines.push(dtEnd);

  if (options?.canceled) {
    lines.push("STATUS:CANCELLED");
  } else if (options?.tentative) {
    lines.push("STATUS:TENTATIVE");
    lines.push("X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE");
  }

  lines.push(`SUMMARY:${escapeICalText(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.location) {
    const loc = event.location.address
      ? `${event.location.name}, ${event.location.address}`
      : event.location.name;
    lines.push(`LOCATION:${escapeICalText(loc)}`);
  }
  if (event.image) lines.push(`X-IMAGE;VALUE=URI:${event.image.url}`);
  if (event.tags) lines.push(`CATEGORIES:${event.tags.map(escapeICalText).join(",")}`);
  if (event.organizer) lines.push(`ORGANIZER:${event.organizer}`);

  lines.push(`CREATED:${toUtcICalDate(event.createdAt)}`);
  lines.push(`LAST-MODIFIED:${toUtcICalDate(event.updatedAt)}`);
  lines.push("END:VEVENT");

  return lines.join("\r\n");
}

export function fromICal(vevent: string): Partial<EveryCalEvent> {
  const properties = parseProperties(vevent);
  const dtStart = firstProperty(properties, "DTSTART");
  const dtEnd = firstProperty(properties, "DTEND");

  const event: Partial<EveryCalEvent> = {
    visibility: "public",
    ...(valueOf(properties, "UID") ? { id: valueOf(properties, "UID") } : {}),
    ...(valueOf(properties, "SUMMARY") ? { title: unescapeICalText(valueOf(properties, "SUMMARY")!) } : {}),
    ...(valueOf(properties, "DESCRIPTION") ? { description: unescapeICalText(valueOf(properties, "DESCRIPTION")!) } : {}),
    ...(valueOf(properties, "URL") ? { url: valueOf(properties, "URL") } : {}),
    ...(valueOf(properties, "CREATED") ? { createdAt: fromICalUtcOrLocal(valueOf(properties, "CREATED")!) } : {}),
    ...(valueOf(properties, "LAST-MODIFIED") ? { updatedAt: fromICalUtcOrLocal(valueOf(properties, "LAST-MODIFIED")!) } : {}),
  };

  if (valueOf(properties, "LOCATION")) {
    event.location = { name: unescapeICalText(valueOf(properties, "LOCATION")!) };
  }

  const image = properties.find((prop) => prop.name === "X-IMAGE" && prop.params.VALUE === "URI")
    || firstProperty(properties, "X-IMAGE");
  if (image?.value) event.image = { url: image.value };

  if (valueOf(properties, "CATEGORIES")) {
    event.tags = valueOf(properties, "CATEGORIES")!
      .split(",")
      .map((tag) => unescapeICalText(tag.trim()));
  }

  if (valueOf(properties, "ORGANIZER")) event.organizer = valueOf(properties, "ORGANIZER")!;

  const parsedStart = parseDateProperty(dtStart);
  const parsedEnd = parseDateProperty(dtEnd);
  if (!parsedStart) return event;

  if (parsedStart.kind === "date") {
    event.allDay = true;
    event.startDate = parsedStart.date;
    event.eventTimezone = parsedStart.tzid || undefined;

    if (parsedEnd?.kind === "date") {
      event.endDate = addDays(parsedEnd.date, -1);
    } else {
      event.endDate = parsedStart.date;
    }

    if (parsedStart.tzid) {
      event.startAtUtc = localInZoneToUtcIso(`${parsedStart.date}T00:00:00`, parsedStart.tzid);
      const exclusiveEnd = addDays(event.endDate, 1);
      event.endAtUtc = localInZoneToUtcIso(`${exclusiveEnd}T00:00:00`, parsedStart.tzid);
      event.timezoneQuality = "exact_tzid";
    } else {
      event.timezoneQuality = "unknown";
    }
  } else {
    event.startDate = parsedStart.display;
    event.startAtUtc = parsedStart.utc || undefined;
    if (parsedEnd?.kind === "date-time") {
      event.endDate = parsedEnd.display;
      event.endAtUtc = parsedEnd.utc || undefined;
    }

    const tzid = parsedStart.tzid || parsedEnd?.tzid || null;
    if (tzid) {
      event.eventTimezone = tzid;
      event.timezoneQuality = "exact_tzid";
    } else {
      const startHadOffset = parsedStart.kind === "date-time" ? parsedStart.hadOffset : false;
      const endHadOffset = parsedEnd?.kind === "date-time" ? parsedEnd.hadOffset : false;
      event.timezoneQuality = startHadOffset || endHadOffset ? "offset_only" : "unknown";
    }
  }

  return event;
}

function getEventTzidForExport(event: EveryCalEvent): string | null {
  if (event.allDay || !event.eventTimezone) return null;
  return isValidIanaTimezone(event.eventTimezone) ? event.eventTimezone : null;
}

function buildDateLine(prefix: "DTSTART" | "DTEND", event: EveryCalEvent, isStart: boolean): string | null {
  const source = isStart ? event.startDate : event.endDate;
  if (!source) return null;

  if (event.allDay) {
    const start = toDateOnly(event.startDate);
    const endInclusive = toDateOnly(event.endDate || event.startDate);
    const value = isStart ? start : addDays(endInclusive, 1);
    return `${prefix};VALUE=DATE:${value.replace(/-/g, "")}`;
  }

  const tzid = getEventTzidForExport(event);
  const utcSource = resolveTimedUtcForExport(event, isStart);
  if (!utcSource) {
    const field = isStart ? "startAtUtc" : "endAtUtc";
    throw new Error(`toICal requires ${field} for timed events (event ${event.id})`);
  }

  if (tzid) {
    const wall = toWallTimeBasic(utcSource, tzid);
    return `${prefix};TZID=${tzid}:${wall}`;
  }

  return `${prefix}:${toUtcICalDate(utcSource)}`;
}

function resolveTimedUtcForExport(event: EveryCalEvent, isStart: boolean): string | null {
  const explicitUtc = isStart ? event.startAtUtc : event.endAtUtc;
  if (explicitUtc) return explicitUtc;

  const source = isStart ? event.startDate : event.endDate;
  if (!source) return null;
  if (ISO_HAS_OFFSET.test(source)) return absoluteIsoToUtcIso(source);

  const tzid = event.eventTimezone;
  if (!tzid || !isValidIanaTimezone(tzid)) return null;

  if (DATE_ONLY.test(source)) return null;
  const normalized = source.includes(" ") ? source.replace(" ", "T") : source;
  if (!LOCAL_DATE_TIME.test(normalized)) return null;
  return localInZoneToUtcIso(normalized, tzid);
}

function toWallTimeBasic(utc: string, tzid: string): string {
  return formatUtcInZone(utc, tzid);
}

function formatUtcInZone(utcIso: string, tzid: string): string {
  const instant = new Date(utcIso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${map.year}${map.month}${map.day}T${map.hour}${map.minute}${map.second}`;
}

function parseProperties(vevent: string): ParsedProperty[] {
  const unfolded = vevent.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const parsed: ParsedProperty[] = [];

  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 1) continue;
    const rawKey = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = rawKey.split(";");
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const [k, v] = part.split("=", 2);
      if (k && v) params[k.toUpperCase()] = v;
    }
    parsed.push({
      name: name.toUpperCase(),
      rawKey,
      params,
      value,
    });
  }

  return parsed;
}

function firstProperty(properties: ParsedProperty[], name: string): ParsedProperty | undefined {
  return properties.find((prop) => prop.name === name);
}

function valueOf(properties: ParsedProperty[], name: string): string | undefined {
  return firstProperty(properties, name)?.value;
}

function parseDateProperty(prop?: ParsedProperty):
  | { kind: "date"; date: string; tzid: string | null }
  | { kind: "date-time"; display: string; utc: string | null; tzid: string | null; hadOffset: boolean }
  | null {
  if (!prop) return null;

  const tzid = prop.params.TZID && isValidIanaTimezone(prop.params.TZID) ? prop.params.TZID : null;
  const value = prop.value;

  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return { kind: "date", date, tzid };
  }

  const m = value.match(/^(\d{8})T(\d{6})(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;

  const date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  const time = `${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}`;
  const suffix = m[3] || "";

  if (tzid) {
    const display = `${date}T${time}`;
    return {
      kind: "date-time",
      display,
      utc: localInZoneToUtcIso(display, tzid),
      tzid,
      hadOffset: false,
    };
  }

  const normalizedSuffix = suffix && suffix !== "Z" && suffix.length === 5
    ? `${suffix.slice(0, 3)}:${suffix.slice(3, 5)}`
    : suffix;
  const display = normalizedSuffix ? `${date}T${time}${normalizedSuffix}` : `${date}T${time}`;
  const utc = absoluteIsoToUtcIso(display);

  return {
    kind: "date-time",
    display,
    utc,
    tzid: null,
    hadOffset: Boolean(normalizedSuffix),
  };
}

function toUtcICalDate(iso: string): string {
  const parsed = new Date(iso);
  return parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fromICalUtcOrLocal(value: string): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}`;
  const dm = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dm) return `${dm[1]}-${dm[2]}-${dm[3]}`;
  return value;
}

function toDateOnly(value: string): string {
  if (DATE_ONLY.test(value)) return value;
  return value.slice(0, 10);
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function absoluteIsoToUtcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!ISO_HAS_OFFSET.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

function localInZoneToUtcIso(localIso: string, timeZone: string): string {
  const m = localIso.match(LOCAL_DATE_TIME);
  if (!m) {
    const parsed = new Date(localIso);
    return Number.isNaN(parsed.getTime()) ? localIso : parsed.toISOString();
  }

  const [, y, mo, d, h, mi, s, frac] = m;
  const milliseconds = frac ? Number(frac.padEnd(3, "0")) : 0;
  const naiveUtcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || "0"));

  let candidateMs = naiveUtcMs;
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(candidateMs), timeZone);
    const next = naiveUtcMs - offset;
    if (next === candidateMs) break;
    candidateMs = next;
  }

  return new Date(candidateMs + milliseconds).toISOString();
}

function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function unescapeICalText(text: string): string {
  return text
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export type { TimezoneQuality };
