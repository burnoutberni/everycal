import { useCallback, useEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import allLocales from "@fullcalendar/core/locales-all";
import type { DatesSetArg, EventClickArg, EventMountArg } from "@fullcalendar/core";
import { Link, useLocation } from "wouter";
import { events as eventsApi, feeds as feedsApi, type CalEvent } from "../lib/api";
import { CheckIcon, LinkIcon, SmartphoneIcon } from "../components/icons";
import { CalendarSubscribeButtons } from "../components/CalendarSubscribeButtons";
import { eventPath } from "../lib/urls";
import { useTranslation } from "react-i18next";
import { formatEventDateTime } from "../lib/formatEventDateTime";
import { useAuth } from "../hooks/useAuth";

import "./CalendarPage.css";

function toFullCalendarEvent(ev: CalEvent) {
  const startStr = ev.startDate.slice(0, 10);
  const endStr = ev.endDate ? ev.endDate.slice(0, 10) : startStr;
  const tentative = ev.rsvpStatus === "maybe";
  const base = {
    id: ev.id,
    title: ev.title,
    extendedProps: { event: ev },
    ...(tentative && { classNames: ["fc-event-tentative"] }),
  };

  if (ev.allDay) {
    const end = ev.endDate ? addOneDay(endStr) : startStr;
    return { ...base, start: startStr, end, allDay: true };
  }

  return {
    ...base,
    start: ev.startDate,
    end: ev.endDate ?? ev.startDate,
    allDay: false,
  };
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/** Add one day for FullCalendar's exclusive end date */
function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function CalendarPage() {
  const { t, i18n } = useTranslation(["calendar", "events"]);
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [visibleRange, setVisibleRange] = useState<{ from: string; to: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedsApi.getCalendarUrl().then(({ url }) => setFeedUrl(url)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!infoOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [infoOpen]);

  const fetchEvents = useCallback(async (from: string, to: string) => {
    setLoading(true);
    try {
      const res = await eventsApi.list({
        from,
        to,
        scope: "calendar",
        limit: 200,
      });
      setEvents(res.events);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }
    if (visibleRange) {
      fetchEvents(visibleRange.from, visibleRange.to);
    }
  }, [user, navigate, visibleRange, fetchEvents]);

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    setVisibleRange({
      from: arg.startStr,
      to: arg.endStr,
    });
  }, []);

  const handleEventClick = useCallback((info: EventClickArg) => {
    info.jsEvent.preventDefault();
    const pin = (info.el as HTMLElement & { _popoverPin?: () => void })._popoverPin;
    if (pin) pin();
  }, []);

  const handleEventDidMount = useCallback(
    (info: EventMountArg) => {
      const ev = info.event.extendedProps.event as CalEvent;
      if (!ev) return;

      const dateStr = formatEventDateTime(ev, true, {
        locale: i18n.language,
        allDayLabel: t("events:allDay"),
      });
      const byLabel = t("events:by");
      const parts: string[] = [dateStr];
      if (ev.location?.name) parts.push(ev.location.name);
      if (ev.account?.displayName || ev.account?.username) {
        parts.push(`${byLabel} ${ev.account.displayName || ev.account.username}`);
      }
      const cleanedDesc = ev.description ? ev.description.replace(/<[^>]*>/g, "") : "";
      const desc = cleanedDesc ? cleanedDesc.slice(0, 120) + (cleanedDesc.length > 120 ? "…" : "") : "";

      const viewDetails = t("events:viewDetails");
      const popover = document.createElement("div");
      popover.className = "fc-event-popover";
      popover.innerHTML = `
        <div class="fc-event-popover-title">${escapeHtml(ev.title)}</div>
        <div class="fc-event-popover-meta">${escapeHtml(parts.join(" · "))}</div>
        ${desc ? `<div class="fc-event-popover-desc">${escapeHtml(desc)}</div>` : ""}
        <div class="fc-event-popover-link" role="button" tabindex="0">${escapeHtml(viewDetails)}</div>
      `;
      const linkEl = popover.querySelector(".fc-event-popover-link")!;
      linkEl.addEventListener("click", (e) => {
        e.stopPropagation();
        navigate(eventPath(ev));
      });
      document.body.appendChild(popover);

      let hideTimeout: ReturnType<typeof setTimeout>;
      let pinned = false;

      const showPopover = () => {
        clearTimeout(hideTimeout);
        // Hide all other popovers
        document.querySelectorAll(".fc-event-popover.fc-event-popover-visible").forEach((p) => {
          p.classList.remove("fc-event-popover-visible");
        });
        const rect = info.el.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        const padding = 8;
        const viewport = { w: window.innerWidth, h: window.innerHeight };

        let top: number;
        let left: number;

        // Prefer above, flip to below if not enough space
        if (rect.top >= popRect.height + padding) {
          top = rect.top - popRect.height - padding;
        } else if (rect.bottom + popRect.height + padding <= viewport.h) {
          top = rect.bottom + padding;
        } else {
          top = Math.max(padding, Math.min(viewport.h - popRect.height - padding, rect.top - popRect.height / 2 + rect.height / 2));
        }

        // Horizontal: align to event, clamp to viewport
        left = rect.left + rect.width / 2 - popRect.width / 2;
        if (left < padding) left = padding;
        if (left + popRect.width > viewport.w - padding) left = viewport.w - popRect.width - padding;

        popover.style.top = `${top}px`;
        popover.style.left = `${left}px`;
        popover.classList.add("fc-event-popover-visible");
      };

      const hidePopover = () => {
        if (pinned) return;
        hideTimeout = setTimeout(() => popover.classList.remove("fc-event-popover-visible"), 50);
      };

      const pinPopover = () => {
        pinned = true;
        showPopover();
      };

      const unpinPopover = () => {
        pinned = false;
        popover.classList.remove("fc-event-popover-visible");
      };

      const handleDocumentClick = (e: MouseEvent) => {
        const target = e.target as Node;
        if (popover.contains(target) || info.el.contains(target)) return;
        unpinPopover();
        document.removeEventListener("click", handleDocumentClick);
      };

      info.el.addEventListener("mouseenter", showPopover);
      info.el.addEventListener("mouseleave", hidePopover);
      popover.addEventListener("mouseenter", () => {
        clearTimeout(hideTimeout);
        popover.classList.add("fc-event-popover-visible");
      });
      popover.addEventListener("mouseleave", () => popover.classList.remove("fc-event-popover-visible"));

      (info.el as HTMLElement & { _popoverPin?: () => void })._popoverPin = () => {
        pinPopover();
        document.addEventListener("click", handleDocumentClick);
      };

      (info.el as HTMLElement & { _popoverCleanup?: () => void })._popoverCleanup = () => {
        document.removeEventListener("click", handleDocumentClick);
        info.el.removeEventListener("mouseenter", showPopover);
        info.el.removeEventListener("mouseleave", hidePopover);
        popover.remove();
      };
    },
    [navigate, t, i18n.language]
  );

  const handleEventWillUnmount = useCallback((info: EventMountArg) => {
    const cleanup = (info.el as HTMLElement & { _popoverCleanup?: () => void })._popoverCleanup;
    if (cleanup) cleanup();
  }, []);

  const handleCopyFeedLink = useCallback(async () => {
    setCopyStatus("copying");
    try {
      const { url } = await feedsApi.getCalendarUrl();
      await navigator.clipboard.writeText(url);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch {
      setCopyStatus("error");
      setTimeout(() => setCopyStatus("idle"), 2000);
    }
  }, []);

  if (!user) {
    return null;
  }

  const fcEvents = events.map(toFullCalendarEvent);

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>{t("myCalendar")}</h1>
        <div className="flex items-center gap-2" style={{ position: "relative" }} ref={infoRef}>
          <button
            type="button"
            className="btn-primary btn-sm calendar-add-trigger"
            onClick={(e) => {
              e.stopPropagation();
              setInfoOpen((o) => !o);
            }}
            title={t("addToDeviceTitle")}
            aria-expanded={infoOpen}
          >
            <SmartphoneIcon />
            {t("addToDevice")}
          </button>
          {infoOpen && (
            <div
              className="calendar-feed-info-popover"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="calendar-feed-info-title">{t("subscribeTitle")}</h3>
              <p className="calendar-feed-info-text">{t("subscribeDesc")}</p>
              <CalendarSubscribeButtons feedUrl={feedUrl} />
              <div className="onboarding-copy-row">
                <button
                  type="button"
                  className={`onboarding-copy-btn ${copyStatus === "copied" ? "copied" : ""}`}
                  onClick={handleCopyFeedLink}
                  disabled={copyStatus === "copying" || !feedUrl}
                >
                  {copyStatus === "copied" ? (
                    <CheckIcon />
                  ) : (
                    <LinkIcon />
                  )}
                  {copyStatus === "copied" && t("copied")}
                  {copyStatus === "error" && t("copyFailed")}
                  {copyStatus === "copying" && t("copying")}
                  {copyStatus === "idle" && t("copyLink")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && (
        <p className="text-muted text-sm" style={{ marginBottom: "0.5rem" }}>{t("loading")}</p>
      )}
      {events.length === 0 && visibleRange && !loading && (
        <p className="text-sm text-dim" style={{ marginBottom: "1rem" }}>
          {t("noEventsInRangeBefore")}
          <Link href="/">{t("eventsPage")}</Link>
          {t("noEventsInRangeAfter")}
        </p>
      )}
      <div className="everycal-fullcalendar">
        <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin]}
              initialView="dayGridMonth"
              locales={allLocales}
              locale={i18n.language}
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: "dayGridMonth,timeGridWeek,timeGridDay",
              }}
              buttonIcons={false}
              buttonText={{
                prev: "\u2039",
                next: "\u203A",
                today: t("today"),
                month: t("month"),
                week: t("week"),
                day: t("day"),
              }}
              firstDay={1}
              events={fcEvents}
              datesSet={handleDatesSet}
              eventClick={handleEventClick}
              eventDidMount={handleEventDidMount}
              eventWillUnmount={handleEventWillUnmount}
              eventDisplay="block"
              height="auto"
            />
      </div>
    </div>
  );
}
