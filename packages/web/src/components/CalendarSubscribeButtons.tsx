import { useMemo } from "react";
import { CalendarIcon } from "./icons";
import { buildCalendarUrls, getCalendarOrder } from "../lib/calendarSubscribe";

interface CalendarSubscribeButtonsProps {
  feedUrl: string | null;
}

export function CalendarSubscribeButtons({ feedUrl }: CalendarSubscribeButtonsProps) {
  const calendarOrder = useMemo(getCalendarOrder, []);
  const urls = buildCalendarUrls(feedUrl);

  if (!feedUrl || !urls) {
    return <span className="calendar-subscribe-loading">Loading…</span>;
  }

  return (
    <div className="calendar-subscribe-buttons">
      {calendarOrder.map((app, i) => {
        const isPrimary = i === 0;
        if (app === "apple") {
          return (
            <a
              key="apple"
              href={urls.webcal}
              className={`calendar-subscribe-btn ${isPrimary ? "calendar-subscribe-btn-primary" : ""}`}
            >
              {isPrimary && <CalendarIcon />}
              Add to Apple Calendar
            </a>
          );
        }
        if (app === "local") {
          return (
            <a
              key="local"
              href={urls.webcal}
              className={`calendar-subscribe-btn ${isPrimary ? "calendar-subscribe-btn-primary" : ""}`}
            >
              {isPrimary && <CalendarIcon />}
              Add to your local calendar
            </a>
          );
        }
        if (app === "google") {
          return (
            <a
              key="google"
              href={urls.google}
              target="_blank"
              rel="noopener noreferrer"
              className={`calendar-subscribe-btn ${isPrimary ? "calendar-subscribe-btn-primary" : ""}`}
            >
              {isPrimary && <CalendarIcon />}
              Add to Google Calendar
            </a>
          );
        }
        return (
          <a
            key="outlook"
            href={urls.outlook}
            target="_blank"
            rel="noopener noreferrer"
            className={`calendar-subscribe-btn ${isPrimary ? "calendar-subscribe-btn-primary" : ""}`}
          >
            {isPrimary && <CalendarIcon />}
            Add to Outlook
          </a>
        );
      })}
    </div>
  );
}
