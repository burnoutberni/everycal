import { useCallback, useEffect, useMemo, useState } from "react";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { EventCard } from "../components/EventCard";
import { MiniCalendar } from "../components/MiniCalendar";
import { useAuth } from "../hooks/useAuth";
import { Link } from "wouter";

const PAGE_SIZE = 20;

type ScopeFilter = "all" | "feed";

function startOfDay(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

function endOfDay(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).toISOString();
}

function formatDateHeading(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function groupByDate(events: CalEvent[]): Map<string, CalEvent[]> {
  const groups = new Map<string, CalEvent[]>();
  for (const ev of events) {
    const key = ev.startDate.slice(0, 10);
    const list = groups.get(key) || [];
    list.push(ev);
    groups.set(key, list);
  }
  return groups;
}

type RangeMode = "day" | "week" | "month" | "upcoming";

function getRangeDates(
  mode: RangeMode,
  selectedDate: Date
): { from: string; to?: string; label: string } {
  const y = selectedDate.getFullYear();
  const m = selectedDate.getMonth();
  const d = selectedDate.getDate();

  switch (mode) {
    case "day":
      return {
        from: startOfDay(selectedDate),
        to: endOfDay(selectedDate),
        label: formatDateHeading(selectedDate),
      };
    case "week": {
      const dow = selectedDate.getDay() || 7;
      const monday = new Date(y, m, d - dow + 1);
      const sunday = new Date(y, m, d - dow + 7);
      return {
        from: startOfDay(monday),
        to: endOfDay(sunday),
        label: `${monday.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${sunday.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
      };
    }
    case "month": {
      const first = new Date(y, m, 1);
      const last = new Date(y, m + 1, 0);
      return {
        from: startOfDay(first),
        to: endOfDay(last),
        label: selectedDate.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      };
    }
    case "upcoming":
    default:
      return {
        from: new Date().toISOString(),
        label: "Upcoming",
      };
  }
}

export function HomePage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [rangeMode, setRangeMode] = useState<RangeMode>("upcoming");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [calendarEventDates, setCalendarEventDates] = useState<Set<string>>(new Set());

  const range = useMemo(() => getRangeDates(rangeMode, selectedDate), [rangeMode, selectedDate]);

  // Fetch event dates for the minicalendar (visible grid, scope filter only)
  const calendarMonthRange = useMemo(() => {
    const y = selectedDate.getFullYear();
    const m = selectedDate.getMonth();
    const firstOfMonth = new Date(y, m, 1);
    const lastOfMonth = new Date(y, m + 1, 0);
    // Monday-first: start on Monday of week containing 1st (getDay: 0=Sun, 1=Mon, ...)
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const firstVisible = new Date(y, m, 1 - startOffset);
    // End on Sunday of week containing last day
    const endOffset = (7 - lastOfMonth.getDay()) % 7;
    const lastVisible = new Date(y, m + 1, 0 + endOffset);
    return { from: startOfDay(firstVisible), to: endOfDay(lastVisible) };
  }, [selectedDate]);

  useEffect(() => {
    let cancelled = false;
    const params: Record<string, string | number> = {
      from: calendarMonthRange.from,
      to: calendarMonthRange.to,
      limit: 500,
    };
    if (scopeFilter === "feed") params.scope = "mine";

    eventsApi
      .list(params as Parameters<typeof eventsApi.list>[0])
      .then((res) => {
        if (!cancelled) {
          setCalendarEventDates(new Set(res.events.map((e) => e.startDate.slice(0, 10))));
        }
      })
      .catch(() => {
        if (!cancelled) setCalendarEventDates(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [calendarMonthRange.from, calendarMonthRange.to, scopeFilter]);

  const fetchEvents = useCallback(
    async (offset = 0, append = false) => {
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);

      try {
        const params: Record<string, string | number> = {
          from: range.from,
          limit: PAGE_SIZE,
          offset,
        };
        if (range.to) params.to = range.to;
        if (scopeFilter === "feed") params.scope = "mine";

        const res = await eventsApi.list(params as Parameters<typeof eventsApi.list>[0]);
        if (append) {
          setEvents((prev) => [...prev, ...res.events]);
        } else {
          setEvents(res.events);
        }
        setHasMore(res.events.length === PAGE_SIZE);
      } catch {
        if (!append) setEvents([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [range, scopeFilter]
  );

  useEffect(() => {
    fetchEvents(0, false);
  }, [fetchEvents]);

  // Reset to "all" if the user logs out while on a logged-in-only filter
  useEffect(() => {
    if (!user && scopeFilter !== "all") setScopeFilter("all");
  }, [user, scopeFilter]);

  const loadMore = () => fetchEvents(events.length, true);

  const grouped = useMemo(() => groupByDate(events), [events]);

  const handleDateSelect = (date: Date) => {
    setSelectedDate(date);
    if (rangeMode === "upcoming") setRangeMode("day");
  };

  const goPrev = () => {
    const d = new Date(selectedDate);
    if (rangeMode === "day") d.setDate(d.getDate() - 1);
    else if (rangeMode === "week") d.setDate(d.getDate() - 7);
    else if (rangeMode === "month") d.setMonth(d.getMonth() - 1);
    setSelectedDate(d);
  };

  const goNext = () => {
    const d = new Date(selectedDate);
    if (rangeMode === "day") d.setDate(d.getDate() + 1);
    else if (rangeMode === "week") d.setDate(d.getDate() + 7);
    else if (rangeMode === "month") d.setMonth(d.getMonth() + 1);
    setSelectedDate(d);
  };

  return (
    <div className="flex gap-2" style={{ alignItems: "flex-start" }}>
      {/* Sidebar */}
      <aside className="hide-mobile" style={{ flex: "0 0 220px", position: "sticky", top: "1rem" }}>
        <MiniCalendar selected={selectedDate} onSelect={handleDateSelect} eventDates={calendarEventDates} />

        {/* Scope filter */}
        <div style={{ marginTop: "1rem" }}>
          <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
            Show
          </div>
          <button
            onClick={() => setScopeFilter("all")}
            className={scopeFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            All Events
          </button>
          {user ? (
            <>
              <button
                onClick={() => setScopeFilter("feed")}
                className={scopeFilter === "feed" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                style={{ marginBottom: "0.3rem" }}
              >
                For me
              </button>
            </>
          ) : (
            <span className="text-sm text-dim" style={{ display: "inline-block", marginTop: "0.2rem" }}>
              <Link href="/login" style={{ color: "var(--accent)" }}>Log in</Link> to see your events
            </span>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1" style={{ minWidth: 0 }}>
        {/* Range controls */}
        <div
          className="flex items-center justify-between"
          style={{ marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}
        >
          <div className="flex items-center gap-1">
            {(["upcoming", "day", "week", "month"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  setRangeMode(mode);
                  if (mode === "upcoming") setSelectedDate(new Date());
                }}
                className={rangeMode === mode ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                style={{ textTransform: "capitalize" }}
              >
                {mode}
              </button>
            ))}
          </div>

          {rangeMode !== "upcoming" && (
            <div className="flex items-center gap-1">
              <button className="btn-ghost btn-sm" onClick={goPrev}>‹</button>
              <span className="text-sm" style={{ fontWeight: 600, minWidth: "10rem", textAlign: "center" }}>
                {range.label}
              </span>
              <button className="btn-ghost btn-sm" onClick={goNext}>›</button>
              <button
                className="btn-ghost btn-sm"
                onClick={() => setSelectedDate(new Date())}
                style={{ marginLeft: "0.25rem" }}
              >
                Today
              </button>
            </div>
          )}
        </div>

        {/* Mobile: inline calendar + scope */}
        <div className="show-mobile" style={{ marginBottom: "1rem" }}>
          <MiniCalendar selected={selectedDate} onSelect={handleDateSelect} eventDates={calendarEventDates} />
          <div className="flex gap-1 mt-1 flex-wrap">
            <button
              onClick={() => setScopeFilter("all")}
              className={scopeFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            >
              All Events
            </button>
            {user && (
              <button
                onClick={() => setScopeFilter("feed")}
                className={scopeFilter === "feed" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              >
                For me
              </button>
            )}
          </div>
        </div>

        {/* Event list */}
        {loading ? (
          <p className="text-muted">Loading…</p>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <p>No events found.</p>
            <p className="text-sm text-dim mt-1">
              {scopeFilter === "feed"
                ? <>Follow accounts on the <Link href="/discover">Discover</Link> page to see their events here.</>
                : rangeMode === "upcoming"
                    ? "Try importing events from the Federation page, or create one!"
                    : "Try a different date range."}
            </p>
          </div>
        ) : (
          <>
            {[...grouped.entries()].map(([dateKey, dayEvents]) => (
              <div key={dateKey} style={{ marginBottom: "1.25rem" }}>
                <h2
                  className="text-sm"
                  style={{
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    marginBottom: "0.4rem",
                    borderBottom: "1px solid var(--border)",
                    paddingBottom: "0.3rem",
                  }}
                >
                  {formatDateHeading(new Date(dateKey + "T00:00:00"))}
                </h2>
                <div className="flex flex-col gap-1">
                  {dayEvents.map((e) => (
                    <EventCard key={e.id} event={e} />
                  ))}
                </div>
              </div>
            ))}

            {hasMore && (
              <div className="text-center mt-2">
                <button className="btn-ghost" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more events"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
