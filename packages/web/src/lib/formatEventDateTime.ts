import i18n from "i18next";

const timeOpts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Format event start/end for display. Handles all-day, end time, and multi-day. */
export function formatEventDateTime(
  event: { startDate: string; endDate: string | null; allDay: boolean },
  long = false,
  options?: { locale?: string; allDayLabel?: string }
): string {
  const locale = options?.locale;
  const allDayLabel = options?.allDayLabel ?? i18n.t("events:allDay");
  const start = new Date(event.startDate);
  const end = event.endDate ? new Date(event.endDate) : null;
  const isCurrentYear = start.getFullYear() === new Date().getFullYear();

  const dateOpts: Intl.DateTimeFormatOptions = long
    ? { weekday: "long", year: "numeric", month: "long", day: "numeric" }
    : {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(isCurrentYear ? {} : { year: "numeric" }),
      };

  const startDateStr = start.toLocaleDateString(locale, dateOpts);

  if (event.allDay) {
    if (!end || isSameDay(start, end)) {
      return `${startDateStr} · ${allDayLabel}`;
    }
    const endDateStr = end.toLocaleDateString(locale, dateOpts);
    return `${startDateStr} – ${endDateStr}`;
  }

  const startTimeStr = start.toLocaleTimeString(locale, timeOpts);

  if (!end || isSameDay(start, end)) {
    const endTimeStr = end ? end.toLocaleTimeString(locale, timeOpts) : null;
    if (endTimeStr && endTimeStr !== startTimeStr) {
      return `${startDateStr} · ${startTimeStr} – ${endTimeStr}`;
    }
    return `${startDateStr} · ${startTimeStr}`;
  }

  const endDateStr = end.toLocaleDateString(locale, dateOpts);
  const endTimeStr = end.toLocaleTimeString(locale, timeOpts);
  return `${startDateStr} · ${startTimeStr} – ${endDateStr} · ${endTimeStr}`;
}
