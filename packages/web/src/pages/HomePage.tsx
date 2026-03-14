import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { dateToLocalYMD, endOfDayForApi, groupEventsByDate, parseLocalYmdDate, resolveNearestDateKey, startOfDayForApi, toLocalYMD } from "../lib/dateUtils";
import { EventCard } from "../components/EventCard";
import { TrashIcon } from "../components/icons";
import { MiniCalendar } from "../components/MiniCalendar";
import { DateEventSection } from "../components/DateEventSection";
import { MobileCalendarFold, type MobileCalendarFoldRef } from "../components/MobileCalendarFold";
import { MobileHeaderContainer } from "../components/MobileHeaderContainer";
import { ScopeToggle, type ScopeFilter } from "../components/ScopeToggle";
import { TagsFold, type TagsFoldRef } from "../components/TagsFold";
import { useAuth } from "../hooks/useAuth";
import { useDateScrollSpy } from "../hooks/useDateScrollSpy";
import { useIsMobile } from "../hooks/useIsMobile";
import { Link } from "wouter";
import { eventsPathWithTags } from "../lib/urls";
import { resolveDateTimeLocale } from "../lib/dateTimeLocale";

const PAGE_SIZE = 20;
/** Height of scope toggle row (All/My events) - part of sticky zone */
const SCOPE_TOGGLE_HEIGHT = 52;


function parseTagsFromSearch(search: string): string[] {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const tags = params.get("tags");
  return tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
}

function parseResetFromSearch(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const reset = params.get("reset");
  return reset === "1" || reset === "true";
}

export function HomePage() {
  const { t, i18n } = useTranslation(["events", "common"]);
  const { user } = useAuth();
  const dateTimeLocale = resolveDateTimeLocale(user, i18n.language);
  const [, navigate] = useLocation();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const dateSectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [calendarEventDates, setCalendarEventDates] = useState<Set<string>>(new Set());
  const [allTags, setAllTags] = useState<string[]>([]);
  const fetchRequestIdRef = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Derive selectedTags from URL; useSearch updates when Link navigates or user uses back/forward
  const searchString = useSearch();
  const selectedTags = useMemo(
    () => parseTagsFromSearch(searchString ? `?${searchString}` : ""),
    [searchString]
  );
  const resetRequested = useMemo(
    () => parseResetFromSearch(searchString ? `?${searchString}` : ""),
    [searchString]
  );

  const isMobile = useIsMobile();

  const [rangeFromOverride, setRangeFromOverride] = useState<string | null>(null);
  const viewingPast = rangeFromOverride != null;
  const range = useMemo(() => {
    if (rangeFromOverride) {
      const parsed = parseLocalYmdDate(rangeFromOverride);
      return {
        from: parsed ? startOfDayForApi(parsed) : rangeFromOverride,
        to: undefined as string | undefined,
      };
    }
    return { from: new Date().toISOString(), to: undefined as string | undefined };
  }, [rangeFromOverride]);

  // Fetch event dates for minicalendar navigation + dots (scope filter only).
  // We extend beyond the visible grid so mobile day-swipe can jump to the next
  // event date even when it's outside the current month view.
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

    const extendedFrom = new Date(firstVisible);
    extendedFrom.setMonth(extendedFrom.getMonth() - 2);
    const extendedTo = new Date(lastVisible);
    extendedTo.setMonth(extendedTo.getMonth() + 2);

    return { from: startOfDayForApi(extendedFrom), to: endOfDayForApi(extendedTo) };
  }, [selectedDate]);

  useEffect(() => {
    let cancelled = false;
    const params: Record<string, string | number | string[]> = {
      from: calendarMonthRange.from,
      to: calendarMonthRange.to,
      limit: 500,
    };
    if (scopeFilter === "feed") params.scope = "mine";
    if (selectedTags.length > 0) params.tags = selectedTags;

    eventsApi
      .list(params as Parameters<typeof eventsApi.list>[0])
      .then((res) => {
        if (!cancelled) {
          setCalendarEventDates(new Set(res.events.map((e) => toLocalYMD(e.startDate))));
        }
      })
      .catch(() => {
        if (!cancelled) setCalendarEventDates(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [calendarMonthRange.from, calendarMonthRange.to, scopeFilter, selectedTags.join(","), user?.id, refreshNonce]);

  const fetchEvents = useCallback(
    async (offset = 0, append = false) => {
      const requestId = ++fetchRequestIdRef.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);

      try {
        const params: Record<string, string | number | string[]> = {
          from: range.from,
          limit: PAGE_SIZE,
          offset,
        };
        if (range.to) params.to = range.to;
        if (scopeFilter === "feed") params.scope = "mine";
        if (selectedTags.length > 0) params.tags = selectedTags;

        const res = await eventsApi.list(params as Parameters<typeof eventsApi.list>[0]);
        if (requestId !== fetchRequestIdRef.current) return;
        if (append) {
          setEvents((prev) => [...prev, ...res.events]);
        } else {
          setEvents(res.events);
        }
        setHasMore(res.events.length === PAGE_SIZE);
      } catch {
        if (requestId !== fetchRequestIdRef.current) return;
        if (!append) setEvents([]);
      } finally {
        if (requestId !== fetchRequestIdRef.current) return;
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [range, scopeFilter, selectedTags.join(","), user?.id, refreshNonce]
  );

  useEffect(() => {
    fetchEvents(0, false);
  }, [fetchEvents]);


  // Fetch available tags (same scope and range as events)
  useEffect(() => {
    let cancelled = false;
    const params: Record<string, string> = {
      from: range.from,
    };
    if (range.to) params.to = range.to;
    if (scopeFilter === "feed") params.scope = "mine";

    eventsApi
      .tags(params)
      .then((res) => {
        if (!cancelled) setAllTags(res.tags);
      })
      .catch(() => {
        if (!cancelled) setAllTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to ?? "", scopeFilter, user?.id, refreshNonce]);

  // Reset to "all" if the user logs out while on a logged-in-only filter
  useEffect(() => {
    if (!user && scopeFilter !== "all") setScopeFilter("all");
  }, [user, scopeFilter]);

  const loadMore = () => fetchEvents(events.length, true);

  const grouped = useMemo(() => groupEventsByDate(events, (e) => toLocalYMD(e.startDate)), [events]);
  const navigableEventDates = useMemo(() => {
    const set = new Set(calendarEventDates);
    for (const key of grouped.keys()) set.add(key);
    return set;
  }, [calendarEventDates, grouped]);
  const [scrollToDate, setScrollToDate] = useState<string | null>(null);
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [tagsUnfolded, setTagsUnfolded] = useState(false);
  const calendarFoldRef = useRef<MobileCalendarFoldRef>(null);
  const tagsFoldRef = useRef<TagsFoldRef>(null);
  const ignoreScrollSpyUntilRef = useRef(0);
  const ignoreScrollCollapseUntilRef = useRef(0);
  const ignoreTagsScrollUntilRef = useRef(0);
  const tagFlipPositionsRef = useRef<Map<string, { left: number; top: number }> | null>(null);
  const calendarExpandedRef = useRef(calendarExpanded);
  calendarExpandedRef.current = calendarExpanded;
  const tagsUnfoldedRef = useRef(tagsUnfolded);
  tagsUnfoldedRef.current = tagsUnfolded;
  const shouldUpdateScrollSpyRef = useRef<() => boolean>(() => true);
  shouldUpdateScrollSpyRef.current = () => !calendarExpandedRef.current && !tagsUnfoldedRef.current;

  const dateKeys = useMemo(() => [...grouped.keys()].sort(), [grouped]);
  useDateScrollSpy({
    dateSectionRefs,
    dateKeys,
    onVisibleDateChange: useCallback((ymd: string) => {
      const [y, m, d] = ymd.split("-").map(Number);
      setSelectedDate((prev) => {
        if (prev.getFullYear() === y && prev.getMonth() === m - 1 && prev.getDate() === d) return prev;
        return new Date(y, m - 1, d);
      });
    }, []),
    ignoreUntilRef: ignoreScrollSpyUntilRef,
    triggerTop: 260,
    shouldUpdateRef: shouldUpdateScrollSpyRef,
  });

  const todayYmd = dateToLocalYMD(new Date());
  const handleDateSelect = (date: Date) => {
    ignoreScrollSpyUntilRef.current = Date.now() + 600;
    setSelectedDate(date);
    setScrollToDate(dateToLocalYMD(date));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    if (d < today) {
      const ymd = dateToLocalYMD(date);
      setRangeFromOverride((prev) => (prev && prev < ymd ? prev : ymd));
    } else {
      setRangeFromOverride(null);
    }
  };

  const handleDateSelectNoScroll = (date: Date) => {
    ignoreScrollSpyUntilRef.current = Date.now() + 600;
    setSelectedDate(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    if (d < today) {
      const ymd = dateToLocalYMD(date);
      setRangeFromOverride((prev) => (prev && prev < ymd ? prev : ymd));
      setScrollToDate(ymd);
    } else {
      setRangeFromOverride(null);
      setScrollToDate(dateToLocalYMD(date));
    }
  };

  const goToUpcoming = useCallback(() => {
    ignoreScrollSpyUntilRef.current = Date.now() + 600;
    const today = new Date();
    const todayKey = dateToLocalYMD(today);
    const sortedCalendarKeys = [...navigableEventDates].sort();
    const nextFromCalendar = sortedCalendarKeys.find((k) => k >= todayKey) || null;
    const sortedLoadedKeys = [...grouped.keys()].sort();
    const nextFromLoaded = sortedLoadedKeys.find((k) => k >= todayKey) || null;
    const targetYmd = nextFromCalendar || nextFromLoaded || todayKey;
    const [y, m, d] = targetYmd.split("-").map(Number);
    setRangeFromOverride(null);
    setSelectedDate(new Date(y, m - 1, d));
    setScrollToDate(targetYmd);
  }, [navigableEventDates, grouped]);

  const handleDateSelectMobile = (date: Date) => {
    handleDateSelect(date);
  };

  useEffect(() => {
    if (!scrollToDate || events.length === 0) return;
    const keys = [...grouped.keys()].sort();
    const lastLoadedKey = keys[keys.length - 1] || null;
    const hasTargetRangeData = viewingPast
      ? keys.some((k) => k < todayYmd)
      : keys.some((k) => k >= todayYmd);
    if (!hasTargetRangeData) {
      return;
    }

    const hasExactDate = keys.includes(scrollToDate);
    const isKnownCalendarDate = navigableEventDates.has(scrollToDate);

    if (viewingPast && !hasExactDate && isKnownCalendarDate) {
      return;
    }

    if (!viewingPast && !hasExactDate && isKnownCalendarDate && hasMore && !loadingMore && lastLoadedKey && scrollToDate > lastLoadedKey) {
      fetchEvents(events.length, true);
      return;
    }

    const targetKey = viewingPast
      ? (hasExactDate ? scrollToDate : resolveNearestDateKey(keys, scrollToDate, true))
      : hasExactDate
        ? scrollToDate
        : resolveNearestDateKey(keys, scrollToDate, false);

    const allowNearestUpcomingFallback = !viewingPast && scrollToDate === todayYmd;
    if (!hasExactDate && !viewingPast && !allowNearestUpcomingFallback && !isKnownCalendarDate && !targetKey) {
      setScrollToDate(null);
      return;
    }

    setScrollToDate(null);
    if (!targetKey) return;
    if (!hasExactDate && !viewingPast) {
      const [y, m, d] = targetKey.split("-").map(Number);
      setSelectedDate(new Date(y, m - 1, d));
    }
    ignoreScrollSpyUntilRef.current = Date.now() + 800;
    ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
    requestAnimationFrame(() => {
      const el = dateSectionRefs.current.get(targetKey);
      if (el) {
        // Ensure selected date is visible below minicalendar + toggle
        if (isMobile) {
          el.style.scrollMarginTop =
            tagsUnfolded
              ? "calc(3.5rem + min(80dvh, 600px))" /* header + tags bar */
              : allTags.length > 0
                ? "calc(3.5rem + 68px + 68px + 52px)" /* header + tags + calendar + scope */
                : "calc(3.5rem + 68px + 52px)"; /* header + calendar + scope (no tags) */
        } else {
          el.style.scrollMarginTop = "calc(3.5rem + 1rem)";
        }
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [
    scrollToDate,
    grouped,
    events.length,
    tagsUnfolded,
    allTags.length,
    isMobile,
    viewingPast,
    todayYmd,
    navigableEventDates,
    hasMore,
    loadingMore,
    loading,
    fetchEvents,
  ]);

  useEffect(() => {
    const positions = tagFlipPositionsRef.current;
    if (!positions || !isMobile || tagsUnfolded) return;
    tagFlipPositionsRef.current = null;
    const container = tagsFoldRef.current?.barElement?.querySelector(".mobile-tags-fold__inner");
    if (!container) return;
    requestAnimationFrame(() => {
      const elements = container.querySelectorAll<HTMLElement>("[data-tag]");
      elements.forEach((el) => {
        const name = el.dataset.tag;
        if (!name) return;
        const oldPos = positions.get(name);
        if (!oldPos) return;
        const rect = el.getBoundingClientRect();
        const dx = oldPos.left - rect.left;
        const dy = oldPos.top - rect.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.willChange = "transform";
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.offsetHeight;
        el.style.transition = "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
        el.style.transform = "";
        el.addEventListener(
          "transitionend",
          () => {
            el.style.transition = "";
            el.style.willChange = "";
          },
          { once: true }
        );
      });
    });
  }, [selectedTags, isMobile, tagsUnfolded]);

  const toggleTag = (tag: string) => {
    const next = selectedTags.includes(tag)
      ? selectedTags.filter((t) => t !== tag)
      : [...selectedTags, tag];
    if (isMobile && !tagsUnfolded) {
      const container = tagsFoldRef.current?.barElement?.querySelector(".mobile-tags-fold__inner");
      if (container) {
        const positions = new Map<string, { left: number; top: number }>();
        container.querySelectorAll("[data-tag]").forEach((el) => {
          const name = (el as HTMLElement).dataset.tag;
          if (name) {
            const rect = el.getBoundingClientRect();
            positions.set(name, { left: rect.left, top: rect.top });
          }
        });
        tagFlipPositionsRef.current = positions;
      }
    }
    navigate(eventsPathWithTags(next));
  };

  const clearTags = () => {
    navigate("/");
  };

  const handleCalendarExpandedChange = useCallback(
    (expanded: boolean) => {
      setCalendarExpanded(expanded);
      if (expanded) {
        ignoreScrollSpyUntilRef.current = Date.now() + 500;
        ignoreScrollCollapseUntilRef.current = Date.now() + 800;
        if (tagsUnfolded) {
          ignoreTagsScrollUntilRef.current = Date.now() + 600;
          setTagsUnfolded(false);
        }
      }
    },
    [tagsUnfolded]
  );

  const handleTagsUnfoldedChange = useCallback(
    (unfolded: boolean) => {
      if (unfolded) {
        ignoreTagsScrollUntilRef.current = Date.now() + 800;
        calendarFoldRef.current?.collapse();
        setTagsUnfolded(true);
      } else {
        setTagsUnfolded(false);
      }
    },
    []
  );

  const closeFolds = useCallback(() => {
    tagsFoldRef.current?.collapse();
    calendarFoldRef.current?.collapse();
  }, []);

  /** Handle explicit homepage reset requests (logo click). */
  useEffect(() => {
    if (!resetRequested) return;
    closeFolds();
    setScopeFilter("all");
    setRangeFromOverride(null);
    goToUpcoming();
    setRefreshNonce((n) => n + 1);
    navigate("/", { replace: true });
  }, [resetRequested, closeFolds, goToUpcoming, navigate]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Node;
      const tagsBar = tagsFoldRef.current?.barElement;
      const calendarBar = calendarFoldRef.current?.barElement;
      if (tagsBar?.contains(target) || calendarBar?.contains(target)) return;
      closeFolds();
    },
    [closeFolds]
  );

  return (
    <div className="flex gap-2" style={{ alignItems: "flex-start" }}>
      {/* Sidebar */}
      <aside className="hide-mobile homepage-sidebar" style={{ flex: "0 0 220px", position: "sticky", top: "calc(3.5rem + 1rem)", alignSelf: "flex-start" }}>
        <MiniCalendar selected={selectedDate} onSelect={handleDateSelect} onMonthNavigate={handleDateSelectNoScroll} eventDates={navigableEventDates} allowPastNavigation />

        {/* Scope filter */}
        <div style={{ marginTop: "1rem" }}>
          <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
            {t("common:show")}
          </div>
          <button
            onClick={() => setScopeFilter("all")}
            className={scopeFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            {t("allEvents")}
          </button>
          {user ? (
            <>
              <button
                onClick={() => setScopeFilter("feed")}
                className={scopeFilter === "feed" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                style={{ marginBottom: "0.3rem" }}
              >
                {t("forMe")}
              </button>
            </>
          ) : (
            <span className="text-sm text-dim" style={{ display: "inline-block", marginTop: "0.2rem" }}>
              <Link href="/login" style={{ color: "var(--accent)" }}>{t("common:logIn")}</Link> {t("logInToSeeEvents")}
            </span>
          )}
        </div>

        {/* Tags filter */}
        {allTags.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
              {t("common:tags")}
            </div>
            <div className="flex gap-1" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTag(t)}
                  className={`tag ${selectedTags.includes(t) ? "tag-selected" : ""}`}
                >
                  {t}
                </button>
              ))}
              {selectedTags.length > 0 && (
                <button
                  type="button"
                  onClick={clearTags}
                  className="tag tag-clear tag-clear-icon"
                  style={{ marginLeft: "0.25rem" }}
                  aria-label={t("common:clear")}
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className="flex-1" style={{ minWidth: 0 }}>
        {/* Mobile: events-first layout — tags (fixed, collapsible) → scope → collapsible calendar → events */}
        <div className={`show-mobile homepage-mobile-layout ${allTags.length > 0 ? "homepage-mobile-has-tags" : ""}`}>
          <MobileHeaderContainer>
            {allTags.length > 0 && (
              <TagsFold
                ref={tagsFoldRef}
                unfolded={tagsUnfolded}
                onUnfoldedChange={handleTagsUnfoldedChange}
                allTags={allTags}
                selectedTags={selectedTags}
                onToggleTag={toggleTag}
                onClearTags={clearTags}
                fixed
                getCalendarBarElement={() => calendarFoldRef.current?.barElement ?? null}
                onOpen={() => calendarFoldRef.current?.collapse()}
                ignoreScrollUntilRef={ignoreTagsScrollUntilRef}
              />
            )}
            <MobileCalendarFold
            ref={calendarFoldRef}
            selectedDate={selectedDate}
            onDateSelect={handleDateSelectMobile}
            eventDates={navigableEventDates}
            allowPastNavigation
            collapseOnSelect
            layout="fixed"
            belowCalendarHeight={SCOPE_TOGGLE_HEIGHT}
            belowCalendar={
              <ScopeToggle
                value={scopeFilter}
                onChange={setScopeFilter}
                showFeedOption={!!user}
              />
            }
            onMonthNavigate={(date) => {
              ignoreScrollSpyUntilRef.current = Date.now() + 600;
              ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
              setSelectedDate(date);
              setScrollToDate(dateToLocalYMD(date));
            }}
            onMonthClick={() => {
              ignoreScrollSpyUntilRef.current = Date.now() + 600;
              ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
              setRangeFromOverride(null);
              setSelectedDate(new Date());
              setScrollToDate(todayYmd);
            }}
            ignoreScrollSpyUntilRef={ignoreScrollSpyUntilRef}
            ignoreScrollCollapseUntilRef={ignoreScrollCollapseUntilRef}
            onExpandedChange={handleCalendarExpandedChange}
          />
          </MobileHeaderContainer>
        </div>

        {/* Event list */}
        <div className="homepage-mobile-events-wrap">
          {isMobile && (tagsUnfolded || calendarExpanded) && (
            <div
              className="homepage-mobile-events-overlay"
              onClick={handleOverlayClick}
              onKeyDown={(e) => e.key === "Enter" && closeFolds()}
              role="button"
              tabIndex={0}
              aria-label={t("common:close")}
            />
          )}
          {loading ? (
            <p className="text-muted">{t("common:loading")}</p>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <p>{t("noEventsFound")}</p>
              <p className="text-sm text-dim mt-1">
                {scopeFilter === "feed"
                  ? <>{t("followAccountsHintBefore")}<Link href="/discover">{t("common:discover")}</Link>{t("followAccountsHintAfter")}</>
                  : t("tryImportingHint")}
              </p>
            </div>
          ) : (
          <>
            {[...grouped.entries()].map(([dateKey, dayEvents]) => {
              const isPast = dateKey < todayYmd;
              return (
              <DateEventSection
                key={dateKey}
                dateKey={dateKey}
                locale={dateTimeLocale}
                isPast={isPast}
                pastLabel={t("events:past")}
                pastLabelClassName="homepage-past-label"
                sectionClassName={`homepage-date-section ${isPast ? "homepage-date-section-past" : ""}`}
                setSectionRef={(el) => {
                  if (el) dateSectionRefs.current.set(dateKey, el);
                }}
              >
                {dayEvents.map((e) => (
                  <EventCard key={e.id} event={e} selectedTags={selectedTags} />
                ))}
              </DateEventSection>
            );
            })}
            {hasMore && (
              <div className="text-center mt-2">
                <button className="btn-ghost" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("common:loading") : t("loadMore")}
                </button>
              </div>
            )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}
