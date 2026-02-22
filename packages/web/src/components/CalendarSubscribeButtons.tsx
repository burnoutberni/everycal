import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CalendarIcon } from "./icons";
import { buildCalendarUrls, getCalendarOrder } from "../lib/calendarSubscribe";

interface CalendarSubscribeButtonsProps {
  feedUrl: string | null;
}

export function CalendarSubscribeButtons({ feedUrl }: CalendarSubscribeButtonsProps) {
  const { t } = useTranslation("calendar");
  const calendarOrder = useMemo(getCalendarOrder, []);
  const urls = buildCalendarUrls(feedUrl);

  if (!feedUrl || !urls) {
    return <span className="calendar-subscribe-loading">{t("loading")}</span>;
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
              {t("addToApple")}
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
              {t("addToLocal")}
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
              {t("addToGoogle")}
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
            {t("addToOutlook")}
          </a>
        );
      })}
    </div>
  );
}
