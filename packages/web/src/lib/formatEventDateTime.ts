import i18n from "i18next";

function isSameDay(a: Date, b: Date, timeZone?: string): boolean {
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit", timeZone };
  return a.toLocaleDateString("en-CA", opts) === b.toLocaleDateString("en-CA", opts);
}

/** Format event start/end for display. Handles all-day, end time, and multi-day. */
export function formatEventDateTime(
  event: { startDate: string; endDate: string | null; allDay: boolean; eventTimezone?: string },
  long = false,
  options?: { locale?: string; allDayLabel?: string; timeFormat?: "12h" | "24h"; viewerTimeZone?: string }
): string {
  const locale = options?.locale;
  const allDayLabel = options?.allDayLabel ?? i18n.t("events:allDay");
  const eventTz = event.eventTimezone;
  const viewerTz = options?.viewerTimeZone;
  const timeZone = eventTz;
  const start = new Date(event.startDate);
  const end = event.endDate ? new Date(event.endDate) : null;
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
    return eventTz && viewerTz && eventTz !== viewerTz ? `${base} (${eventTz})` : base;
  }

  const endDateStr = end.toLocaleDateString(locale, dateOpts);
  const endTimeStr = end.toLocaleTimeString(locale, timeOpts);
  const base = `${startDateStr} · ${startTimeStr} – ${endDateStr} · ${endTimeStr}`;
  return eventTz && viewerTz && eventTz !== viewerTz ? `${base} (${eventTz})` : base;
}
