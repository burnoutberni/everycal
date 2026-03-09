import i18n from "i18next";

function safeTimeZone(tz?: string): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function zoneOffsetToken(timeZone: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")
      ?.value || "";
  } catch {
    return "";
  }
}

function zonesEquivalent(a: string, b: string, date: Date): boolean {
  if (a === b) return true;
  const jan = new Date(Date.UTC(date.getUTCFullYear(), 0, 15));
  const jul = new Date(Date.UTC(date.getUTCFullYear(), 6, 15));
  return zoneOffsetToken(a, date) === zoneOffsetToken(b, date)
    && zoneOffsetToken(a, jan) === zoneOffsetToken(b, jan)
    && zoneOffsetToken(a, jul) === zoneOffsetToken(b, jul);
}

function localizedTimeZoneCity(timeZone: string, locale?: string): string {
  const city = (timeZone.split("/").pop() || timeZone).replace(/_/g, " ");
  const lang = (locale || "").toLowerCase().split("-")[0];
  if (lang === "de") {
    const deCity: Record<string, string> = {
      Vienna: "Wien",
      Cologne: "Koln",
      Munich: "Munchen",
    };
    return deCity[city] || city;
  }
  return city;
}

function dayKey(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
}

export function timeZoneCityLabel(timeZone: string, locale?: string): string {
  return localizedTimeZoneCity(timeZone, locale);
}

function isSameDay(a: Date, b: Date, timeZone?: string): boolean {
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit", timeZone };
  return a.toLocaleDateString("en-CA", opts) === b.toLocaleDateString("en-CA", opts);
}

/** Format event start/end for display. Handles all-day, end time, and multi-day. */
export function formatEventDateTime(
  event: { startDate: string; endDate: string | null; startAtUtc?: string; endAtUtc?: string | null; allDay: boolean; eventTimezone?: string },
  long = false,
  options?: {
    locale?: string;
    allDayLabel?: string;
    timeFormat?: "12h" | "24h";
    viewerTimeZone?: string;
    displayTimeZone?: string;
  }
): string {
  const locale = options?.locale;
  const allDayLabel = options?.allDayLabel ?? i18n.t("events:allDay");
  const eventTz = safeTimeZone(event.eventTimezone);
  const displayTz = safeTimeZone(options?.displayTimeZone);
  const timeZone = displayTz || eventTz;
  const startInstant = event.allDay ? event.startDate : (event.startAtUtc || event.startDate);
  const endInstant = event.allDay ? event.endDate : (event.endAtUtc || event.endDate);
  const start = new Date(startInstant);
  const end = endInstant ? new Date(endInstant) : null;
  const isCurrentYear = start.getFullYear() === new Date().getFullYear();

  const dateOpts: Intl.DateTimeFormatOptions = long
    ? { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone }
    : {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(isCurrentYear ? {} : { year: "numeric" }),
        timeZone,
      };

  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: options?.timeFormat ? options.timeFormat === "12h" : undefined,
    timeZone,
  };

  const startDateStr = start.toLocaleDateString(locale, dateOpts);
  if (event.allDay) {
    if (!end || isSameDay(start, end, timeZone)) {
      return `${startDateStr} · ${allDayLabel}`;
    }
    const endDateStr = end.toLocaleDateString(locale, dateOpts);
    return `${startDateStr} – ${endDateStr}`;
  }

  const startTimeStr = start.toLocaleTimeString(locale, timeOpts);

  if (!end || isSameDay(start, end, timeZone)) {
    const endTimeStr = end ? end.toLocaleTimeString(locale, timeOpts) : null;
    const base = endTimeStr && endTimeStr !== startTimeStr
      ? `${startDateStr} · ${startTimeStr} – ${endTimeStr}`
      : `${startDateStr} · ${startTimeStr}`;
    return base;
  }

  const endDateStr = end.toLocaleDateString(locale, dateOpts);
  const endTimeStr = end.toLocaleTimeString(locale, timeOpts);
  return `${startDateStr} · ${startTimeStr} – ${endDateStr} · ${endTimeStr}`;
}

export function hasDifferentTimezoneAtEventTime(
  event: { startDate: string; startAtUtc?: string; allDay: boolean; eventTimezone?: string },
  viewerTimeZone?: string
): boolean {
  const eventTz = safeTimeZone(event.eventTimezone);
  const viewerTz = safeTimeZone(viewerTimeZone);
  if (!eventTz || !viewerTz) return false;
  const startInstant = event.allDay ? event.startDate : (event.startAtUtc || event.startDate);
  const start = new Date(startInstant);
  return !zonesEquivalent(eventTz, viewerTz, start);
}

export function formatViewerTimezoneTooltip(
  event: { startDate: string; endDate: string | null; startAtUtc?: string; endAtUtc?: string | null; allDay: boolean; eventTimezone?: string },
  options?: { locale?: string; allDayLabel?: string; timeFormat?: "12h" | "24h"; viewerTimeZone?: string }
): string {
  const locale = options?.locale;
  const viewerTz = safeTimeZone(options?.viewerTimeZone);
  const eventTz = safeTimeZone(event.eventTimezone);
  if (!viewerTz || !eventTz) return "";
  if (!hasDifferentTimezoneAtEventTime(event, viewerTz)) return "";

  const city = localizedTimeZoneCity(viewerTz, locale);
  if (event.allDay) {
    const viewerLabel = formatEventDateTime({ ...event, eventTimezone: viewerTz }, true, {
      locale,
      allDayLabel: options?.allDayLabel,
      timeFormat: options?.timeFormat,
      viewerTimeZone: viewerTz,
    });
    return `${city}: ${viewerLabel}`;
  }

  const startInstant = event.startAtUtc || event.startDate;
  const endInstant = event.endAtUtc || event.endDate;
  const start = new Date(startInstant);
  const end = endInstant ? new Date(endInstant) : null;

  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(start.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    timeZone: viewerTz,
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: options?.timeFormat ? options.timeFormat === "12h" : undefined,
    timeZone: viewerTz,
  };

  const startTime = start.toLocaleTimeString(locale, timeOpts);
  const eventStartDay = dayKey(start, eventTz);
  const viewerStartDay = dayKey(start, viewerTz);
  let body = startTime;

  if (end) {
    const endTime = end.toLocaleTimeString(locale, timeOpts);
    if (endTime !== startTime || !isSameDay(start, end, viewerTz)) {
      body = `${startTime} – ${endTime}`;
    }
    if (!isSameDay(start, end, viewerTz)) {
      const startDate = start.toLocaleDateString(locale, dateOpts);
      const endDate = end.toLocaleDateString(locale, dateOpts);
      body = `${startDate} · ${startTime} – ${endDate} · ${endTime}`;
    }
  }

  const shouldIncludeDate = eventStartDay !== viewerStartDay;
  if (shouldIncludeDate && end && isSameDay(start, end, viewerTz)) {
    const startDate = start.toLocaleDateString(locale, dateOpts);
    body = `${startDate} · ${body}`;
  } else if (shouldIncludeDate && !end) {
    const startDate = start.toLocaleDateString(locale, dateOpts);
    body = `${startDate} · ${body}`;
  }

  return `${city}: ${body}`;
}
