/**
 * Convert between EveryCal events and iCalendar VEVENT strings.
 *
 * Header images are stored as an X-IMAGE extended property since
 * standard iCal has no first-class image field (IMAGE was added in
 * RFC 7986 but support is patchy).
 */

import { EveryCalEvent } from "./event.js";

/** Produce a VEVENT string (without the VCALENDAR wrapper). */
export function toICal(event: EveryCalEvent): string {
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${event.id}`,
    `DTSTAMP:${toICalDate(event.updatedAt)}`,
    `DTSTART:${toICalDate(event.startDate)}`,
  ];

  if (event.endDate) lines.push(`DTEND:${toICalDate(event.endDate)}`);
  lines.push(`SUMMARY:${escapeICalText(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.location) lines.push(`LOCATION:${escapeICalText(event.location.name)}`);
  if (event.image) lines.push(`X-IMAGE;VALUE=URI:${event.image.url}`);
  if (event.tags) {
    lines.push(`CATEGORIES:${event.tags.map(escapeICalText).join(",")}`);
  }
  if (event.organizer) lines.push(`ORGANIZER:${event.organizer}`);

  lines.push(`CREATED:${toICalDate(event.createdAt)}`);
  lines.push(`LAST-MODIFIED:${toICalDate(event.updatedAt)}`);
  lines.push("END:VEVENT");

  return lines.join("\r\n");
}

/** Parse a VEVENT string back into a (partial) EveryCal event. */
export function fromICal(vevent: string): Partial<EveryCalEvent> {
  const props = parseProperties(vevent);

  const event: Partial<EveryCalEvent> = {
    id: props["UID"],
    title: props["SUMMARY"] ? unescapeICalText(props["SUMMARY"]) : undefined,
    description: props["DESCRIPTION"] ? unescapeICalText(props["DESCRIPTION"]) : undefined,
    startDate: props["DTSTART"] ? fromICalDate(props["DTSTART"]) : undefined,
    endDate: props["DTEND"] ? fromICalDate(props["DTEND"]) : undefined,
    url: props["URL"],
    createdAt: props["CREATED"] ? fromICalDate(props["CREATED"]) : undefined,
    updatedAt: props["LAST-MODIFIED"] ? fromICalDate(props["LAST-MODIFIED"]) : undefined,
    visibility: "public", // iCal doesn't carry visibility in our sense
  };

  if (props["LOCATION"]) {
    event.location = { name: unescapeICalText(props["LOCATION"]) };
  }

  // X-IMAGE;VALUE=URI — our custom property
  const imageUrl = props["X-IMAGE"] || props["X-IMAGE;VALUE=URI"];
  if (imageUrl) {
    event.image = { url: imageUrl };
  }

  if (props["CATEGORIES"]) {
    event.tags = props["CATEGORIES"].split(",").map((t) => unescapeICalText(t.trim()));
  }

  if (props["ORGANIZER"]) {
    event.organizer = props["ORGANIZER"];
  }

  // DTSTART;VALUE=DATE indicates an all-day event (date-only, no time)
  const dtStartIsDateOnly = Object.keys(props).some(
    (k) => k.startsWith("DTSTART") && k.includes("VALUE=DATE")
  );
  if (dtStartIsDateOnly) {
    event.allDay = true;
  }

  return event;
}

// ---- helpers ----

function parseProperties(vevent: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Unfold continuation lines (RFC 5545 §3.1)
  const unfolded = vevent.replace(/\r?\n[ \t]/g, "");
  for (const line of unfolded.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 1) continue;
    const rawKey = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1);

    // Store under full key (e.g. "DTSTART;TZID=Europe/Berlin")
    if (!(rawKey in result)) result[rawKey] = value;

    // Also store under base property name (e.g. "DTSTART")
    // so lookups by base name work regardless of parameters
    const semiIdx = rawKey.indexOf(";");
    if (semiIdx > 0) {
      const baseName = rawKey.slice(0, semiIdx);
      if (!(baseName in result)) result[baseName] = value;
    }
  }
  return result;
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

function toICalDate(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function fromICalDate(ical: string): string {
  // 20260210T213000Z -> 2026-02-10T21:30:00Z
  const m = ical.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}`;
  // 20260210 (DATE only, VALUE=DATE) -> 2026-02-10T12:00:00.000Z (noon UTC for all-day)
  const dm = ical.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dm) return `${dm[1]}-${dm[2]}-${dm[3]}T12:00:00.000Z`;
  return ical;
}
