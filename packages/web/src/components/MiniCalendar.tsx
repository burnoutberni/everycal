import { useMemo, useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { dateToLocalYMD } from "../lib/dateUtils";
import { useAuth } from "../hooks/useAuth";
import { localeWeekStart, resolveDateTimeLocale } from "../lib/dateTimeLocale";

const SWIPE_THRESHOLD = 50;

/** Event listener options for touch handlers. Cast needed for older DOM typings. */
const PASSIVE_OPT = { passive: true } as AddEventListenerOptions;
const NOT_PASSIVE_OPT = { passive: false } as AddEventListenerOptions;

interface MiniCalendarProps {
  /** Currently selected date */
  selected: Date;
  /** Callback when a date is clicked */
  onSelect: (date: Date) => void;
  /** Set of YYYY-MM-DD strings (local timezone) that have events */
  eventDates?: Set<string>;
  /** When true, show compact single-row; tap to expand. For mobile. */
  collapsible?: boolean;
  /** Controlled collapsed state (when collapsible) */
  collapsed?: boolean;
  /** Callback when user toggles collapsed state */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** When true and collapsed, ‹ › navigate by day instead of month */
  navigateByDay?: boolean;
  /** When provided, month button calls this instead of goToday (e.g. to collapse) */
  onMonthClick?: () => void;
  /** When provided, month navigation (arrows, swipe) uses this instead of onSelect. Use to avoid closing a fold on month change. */
  onMonthNavigate?: (date: Date) => void;
  /** Ref set to true while user is touching the calendar (swiping). Parent can check to avoid collapsing on scroll. */
  interactionRef?: React.MutableRefObject<boolean | null>;
  /**
   * When true, disable eventDates-based month restrictions in expanded mode.
   * This allows free month navigation in both directions (past + future).
   */
  allowPastNavigation?: boolean;
}

function getDayNames(locale: string, firstDay: number): string[] {
  const days: string[] = [];
  const base = new Date(2024, 0, 7 + firstDay);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    days.push(d.toLocaleDateString(locale, { weekday: "short" }).slice(0, 2));
  }
  return days;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isPast(day: Date, today: Date): boolean {
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  return dayStart < todayStart;
}

function getWeeksForMonth(year: number, month: number, firstDay: number): Date[][] {
  const first = new Date(year, month, 1);
  const startDay = (first.getDay() - firstDay + 7) % 7;
  const rows: Date[][] = [];
  let current = new Date(year, month, 1 - startDay);
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    rows.push(week);
    if (week[0].getMonth() > month && week[0].getFullYear() >= year) break;
  }
  return rows;
}

function formatDateLabel(d: Date, today: Date, i18n: { t: (key: string) => string }, locale: string): string {
  if (sameDay(d, today)) return i18n.t("common:today");
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return i18n.t("common:yesterday");
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(d, tomorrow)) return i18n.t("common:tomorrow");
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(locale, opts);
}

export function MiniCalendar({ selected, onSelect, eventDates, collapsible, collapsed = true, onCollapsedChange, navigateByDay, onMonthClick, onMonthNavigate, interactionRef, allowPastNavigation = false }: MiniCalendarProps) {
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const locale = resolveDateTimeLocale(user, i18n.language);
  const firstDay = localeWeekStart(locale);
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const today = new Date();
  const isAtCurrentMonth = year === today.getFullYear() && month === today.getMonth();
  const touchStartX = useRef<number | null>(null);
  const collapsedRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);
  const committingToRef = useRef<"prev" | "next" | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [committingTo, setCommittingTo] = useState<"prev" | "next" | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  committingToRef.current = committingTo;

  const dayNames = useMemo(() => getDayNames(locale, firstDay), [firstDay, locale]);

  /**
   * Expanded month navigation targets derived from eventDates.
   * When allowPastNavigation=true we intentionally return null (no restrictions),
   * so arrow/swipe month navigation is free-form instead of skipping empty months.
   */
  const expandedNavTargets = useMemo(() => {
    if (!eventDates || eventDates.size === 0 || !collapsible || allowPastNavigation) return null;
    const months = new Set<string>();
    for (const ymd of eventDates) {
      months.add(ymd.slice(0, 7));
    }
    const sorted = [...months].sort();
    if (sorted.length === 0) return null;
    const currentKey = `${year}-${String(month + 1).padStart(2, "0")}`;
    const prevKey = sorted.filter((m) => m < currentKey).pop() ?? null;
    const nextKey = sorted.find((m) => m > currentKey) ?? null;
    return {
      canGoPrev: prevKey != null,
      canGoNext: nextKey != null,
      prevTarget: prevKey ? (() => { const [y, m] = prevKey.split("-").map(Number); return new Date(y, m - 1, 1); })() : null,
      nextTarget: nextKey ? (() => { const [y, m] = nextKey.split("-").map(Number); return new Date(y, m - 1, 1); })() : null,
    };
  }, [eventDates, collapsible, year, month, allowPastNavigation]);

  const prevMonth = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (expandedNavTargets && !expandedNavTargets.canGoPrev) return;
    const date = expandedNavTargets?.prevTarget ?? new Date(year, month - 1, 1);
    (onMonthNavigate ?? onSelect)(date);
  };
  const nextMonth = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (expandedNavTargets && !expandedNavTargets.canGoNext) return;
    const date = expandedNavTargets?.nextTarget ?? new Date(year, month + 1, 1);
    (onMonthNavigate ?? onSelect)(date);
  };
  const goToday = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onSelect(new Date());
  };

  const prevDate = useMemo(() => {
    if (navigateByDay && eventDates && eventDates.size > 0) {
      const selectedYmd = dateToLocalYMD(selected);
      const sorted = [...eventDates].sort();
      const idx = sorted.findIndex((d) => d >= selectedYmd);
      if (idx === 0 && !allowPastNavigation) return new Date(selected);
      const prevYmd = idx < 0 ? sorted[sorted.length - 1] : (idx > 0 ? sorted[idx - 1] : null);
      if (prevYmd) {
        const [y, m, d] = prevYmd.split("-").map(Number);
        return new Date(y, m - 1, d);
      }
    }
    if (navigateByDay) {
      const d = new Date(selected);
      d.setDate(d.getDate() - 1);
      return d;
    }
    return new Date(selected.getFullYear(), selected.getMonth() - 1, 1);
  }, [selected, navigateByDay, eventDates, allowPastNavigation]);
  const nextDate = useMemo(() => {
    if (navigateByDay && eventDates && eventDates.size > 0) {
      const selectedYmd = dateToLocalYMD(selected);
      const sorted = [...eventDates].sort();
      const idx = sorted.findIndex((d) => d > selectedYmd);
      const nextYmd = idx < 0 ? null : sorted[idx];
      if (nextYmd) {
        const [y, m, d] = nextYmd.split("-").map(Number);
        return new Date(y, m - 1, d);
      }
      return new Date(selected);
    }
    if (navigateByDay) {
      const d = new Date(selected);
      d.setDate(d.getDate() + 1);
      return d;
    }
    return new Date(selected.getFullYear(), selected.getMonth() + 1, 1);
  }, [selected, navigateByDay, eventDates]);

  const prevDay = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onSelect(prevDate);
  };
  const nextDay = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onSelect(nextDate);
  };

  // Touch handlers: move for visible swipe, end for commit or expand
  useEffect(() => {
    const el = collapsedRef.current;
    if (!el || !collapsible || !collapsed) return;
    const slideContainer = el.querySelector<HTMLDivElement>("[data-slide-container]");
    const handleTouchStart = () => {
      interactionRef && (interactionRef.current = true);
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (touchStartX.current == null || committingToRef.current) return;
      const x = e.touches[0]?.clientX ?? touchStartX.current;
      let deltaX = x - touchStartX.current;
      const slideWidth = slideContainer?.getBoundingClientRect().width ?? 200;
      deltaX = Math.max(-slideWidth, Math.min(slideWidth, deltaX));
      if (sameDay(prevDate, selected)) deltaX = Math.min(0, deltaX);
      setSwipeOffset(deltaX);
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (touchStartX.current == null) return;
      const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
      const deltaX = endX - touchStartX.current;
      touchStartX.current = null;

      if (Math.abs(deltaX) >= SWIPE_THRESHOLD) {
        interactionRef && (interactionRef.current = false);
        const slideWidth = slideContainer?.getBoundingClientRect().width ?? 100;
        if (deltaX < 0) {
          setCommittingTo("next");
          setSwipeOffset(-slideWidth); // animate to show next slide at center
          const onTransitionEnd = () => {
            slideContainer?.removeEventListener("transitionend", onTransitionEnd);
            onSelect(nextDate);
            setIsResetting(true);
            setCommittingTo(null);
            setSwipeOffset(0);
          };
          requestAnimationFrame(() => {
            slideContainer?.addEventListener("transitionend", onTransitionEnd, { once: true });
          });
        } else if (!sameDay(prevDate, selected)) {
          setCommittingTo("prev");
          setSwipeOffset(slideWidth);
          const onTransitionEnd = () => {
            slideContainer?.removeEventListener("transitionend", onTransitionEnd);
            onSelect(prevDate);
            setIsResetting(true);
            setCommittingTo(null);
            setSwipeOffset(0);
          };
          requestAnimationFrame(() => {
            slideContainer?.addEventListener("transitionend", onTransitionEnd, { once: true });
          });
        } else {
          setSwipeOffset(0);
        }
      } else {
        setSwipeOffset(0);
        const target = e.target as Element;
        if (target.closest?.(".mini-calendar-nav-btn")) {
          interactionRef && (interactionRef.current = false);
          return;
        }
        e.preventDefault();
        interactionRef && (interactionRef.current = false);
        onCollapsedChange?.(false);
      }
      interactionRef && (interactionRef.current = false);
    };
    const handleTouchCancel = () => {
      touchStartX.current = null;
      interactionRef && (interactionRef.current = false);
    };
    el.addEventListener("touchstart", handleTouchStart as EventListener, PASSIVE_OPT);
    el.addEventListener("touchmove", handleTouchMove as EventListener, PASSIVE_OPT);
    el.addEventListener("touchend", handleTouchEnd as EventListener, NOT_PASSIVE_OPT);
    el.addEventListener("touchcancel", handleTouchCancel as EventListener, PASSIVE_OPT);
    return () => {
      el.removeEventListener("touchstart", handleTouchStart as EventListener, PASSIVE_OPT);
      el.removeEventListener("touchmove", handleTouchMove as EventListener, PASSIVE_OPT);
      el.removeEventListener("touchend", handleTouchEnd as EventListener, NOT_PASSIVE_OPT);
      el.removeEventListener("touchcancel", handleTouchCancel as EventListener, PASSIVE_OPT);
      interactionRef && (interactionRef.current = false);
    };
  }, [collapsible, collapsed, onCollapsedChange, selected, onSelect, navigateByDay, prevDate, nextDate, interactionRef]);

  // Touch handlers for expanded calendar: swipe between months
  useEffect(() => {
    const el = expandedRef.current;
    if (!el || !collapsible || collapsed) return;
    const slideContainer = el.querySelector<HTMLDivElement>("[data-expanded-slide-container]");
    const handleTouchStart = (e: TouchEvent) => {
      touchStartX.current = e.touches[0]?.clientX ?? null;
      interactionRef && (interactionRef.current = true);
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (touchStartX.current == null || committingToRef.current) return;
      e.preventDefault();
      const x = e.touches[0]?.clientX ?? touchStartX.current;
      let deltaX = x - touchStartX.current;
      const slideWidth = slideContainer?.getBoundingClientRect().width ?? 200;
      deltaX = Math.max(-slideWidth, Math.min(slideWidth, deltaX));
      if (expandedNavTargets) {
        if (!expandedNavTargets.canGoNext) deltaX = Math.max(0, deltaX);  // block swipe left
        if (!expandedNavTargets.canGoPrev) deltaX = Math.min(0, deltaX);   // block swipe right
      } else if (isAtCurrentMonth && !allowPastNavigation) {
        deltaX = Math.min(0, deltaX);
      }
      setSwipeOffset(deltaX);
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (touchStartX.current == null) return;
      const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
      const deltaX = endX - touchStartX.current;
      touchStartX.current = null;

      if (Math.abs(deltaX) >= SWIPE_THRESHOLD) {
        e.preventDefault();
        interactionRef && (interactionRef.current = false);
        const slideWidth = slideContainer?.getBoundingClientRect().width ?? 100;
        const canNext = expandedNavTargets ? expandedNavTargets.canGoNext : true;
        const canPrev = expandedNavTargets ? expandedNavTargets.canGoPrev : (allowPastNavigation || !isAtCurrentMonth);
        const nextTarget = expandedNavTargets?.nextTarget ?? new Date(year, month + 1, 1);
        const prevTarget = expandedNavTargets?.prevTarget ?? new Date(year, month - 1, 1);
        if (deltaX < 0 && canNext) {
          setCommittingTo("next");
          setSwipeOffset(-slideWidth);
          const onTransitionEnd = () => {
            slideContainer?.removeEventListener("transitionend", onTransitionEnd);
            (onMonthNavigate ?? onSelect)(nextTarget);
            setIsResetting(true);
            setCommittingTo(null);
            setSwipeOffset(0);
          };
          requestAnimationFrame(() => {
            slideContainer?.addEventListener("transitionend", onTransitionEnd, { once: true });
          });
        } else if (deltaX > 0 && canPrev) {
          setCommittingTo("prev");
          setSwipeOffset(slideWidth);
          const onTransitionEnd = () => {
            slideContainer?.removeEventListener("transitionend", onTransitionEnd);
            (onMonthNavigate ?? onSelect)(prevTarget);
            setIsResetting(true);
            setCommittingTo(null);
            setSwipeOffset(0);
          };
          requestAnimationFrame(() => {
            slideContainer?.addEventListener("transitionend", onTransitionEnd, { once: true });
          });
        } else {
          setSwipeOffset(0);
        }
      } else {
        if (Math.abs(deltaX) > 10) e.preventDefault();
        setSwipeOffset(0);
      }
      interactionRef && (interactionRef.current = false);
    };
    const handleTouchCancel = () => {
      touchStartX.current = null;
      interactionRef && (interactionRef.current = false);
    };
    el.addEventListener("touchstart", handleTouchStart as EventListener, PASSIVE_OPT);
    el.addEventListener("touchmove", handleTouchMove as EventListener, NOT_PASSIVE_OPT);
    el.addEventListener("touchend", handleTouchEnd as EventListener, NOT_PASSIVE_OPT);
    el.addEventListener("touchcancel", handleTouchCancel as EventListener, PASSIVE_OPT);
    return () => {
      el.removeEventListener("touchstart", handleTouchStart as EventListener, PASSIVE_OPT);
      el.removeEventListener("touchmove", handleTouchMove as EventListener, NOT_PASSIVE_OPT);
      el.removeEventListener("touchend", handleTouchEnd as EventListener, NOT_PASSIVE_OPT);
      el.removeEventListener("touchcancel", handleTouchCancel as EventListener, PASSIVE_OPT);
      interactionRef && (interactionRef.current = false);
    };
  }, [collapsible, collapsed, year, month, onSelect, onMonthNavigate, interactionRef, isAtCurrentMonth, expandedNavTargets, allowPastNavigation]);

  useEffect(() => {
    setSwipeOffset(0);
  }, [selected]);

  useEffect(() => {
    setSwipeOffset(0);
    setCommittingTo(null);
  }, [collapsed]);

  useEffect(() => {
    if (!isResetting) return;
    const id = requestAnimationFrame(() => {
      setIsResetting(false);
    });
    return () => cancelAnimationFrame(id);
  }, [isResetting]);

  const monthLabel = selected.toLocaleDateString(locale, { month: "long", year: "numeric" });
  const selectedLabel = formatDateLabel(selected, today, i18n, locale);
  const prevLabel = navigateByDay
    ? formatDateLabel(prevDate, today, i18n, locale)
    : prevDate.toLocaleDateString(locale, { month: "long", year: "numeric" });
  const nextLabel = navigateByDay
    ? formatDateLabel(nextDate, today, i18n, locale)
    : nextDate.toLocaleDateString(locale, { month: "long", year: "numeric" });

  const weeks = useMemo(() => getWeeksForMonth(year, month, firstDay), [firstDay, month, year]);

  if (collapsible && collapsed) {
    const goPrev = navigateByDay ? prevDay : prevMonth;
    const goNext = navigateByDay ? nextDay : nextMonth;
    const handleExpand = (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onCollapsedChange?.(false);
    };
    const handleNavClick = (fn: (e?: React.MouseEvent) => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      fn(e);
    };
    return (
      <div
        ref={collapsedRef}
        className="mini-calendar-collapsed"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onCollapsedChange?.(false)}
        style={{ userSelect: "none" }}
        aria-expanded={false}
        aria-label={monthLabel}
        onClick={handleExpand}
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0]?.clientX ?? null;
        }}
      >
        <button
          type="button"
          className="mini-calendar-nav-btn"
          disabled={sameDay(prevDate, selected)}
          onClick={handleNavClick(goPrev)}
          onTouchEnd={(e) => {
            e.stopPropagation();
            touchStartX.current = null;
          }}
        >
          ‹
        </button>
        <div
          data-slide-container
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            touchAction: "pan-y",
          }}
        >
          <div
            style={{
              display: "flex",
              width: "300%",
              transform: `translateX(calc(-33.333% + ${swipeOffset}px))`,
              transition: isResetting ? "none" : committingTo ? "transform 0.25s ease-out" : swipeOffset === 0 ? "transform 0.2s ease-out" : "none",
            }}
          >
            <div
              className="mini-calendar-collapsed-label"
              style={{
                width: "33.333%",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.9rem",
                fontWeight: 600,
                pointerEvents: "none",
              }}
            >
              {prevLabel}
            </div>
            <div
              className="mini-calendar-collapsed-label"
              style={{
                width: "33.333%",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.9rem",
                fontWeight: 600,
                pointerEvents: "none",
              }}
            >
              {selectedLabel}
            </div>
            <div
              className="mini-calendar-collapsed-label"
              style={{
                width: "33.333%",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.9rem",
                fontWeight: 600,
                pointerEvents: "none",
              }}
            >
              {nextLabel}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="mini-calendar-nav-btn"
          disabled={sameDay(nextDate, selected)}
          onClick={handleNavClick(goNext)}
          onTouchEnd={(e) => {
            e.stopPropagation();
            touchStartX.current = null;
          }}
        >
          ›
        </button>
      </div>
    );
  }

  const renderMonthSlide = (y: number, m: number) => {
    const slideWeeks = getWeeksForMonth(y, m, firstDay);
    const slideMonthLabel = new Date(y, m, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
    return (
      <div key={`${y}-${m}`} style={{ width: "33.333%", flexShrink: 0, minWidth: 0, padding: "0 0.1rem" }}>
        <div className="flex items-center justify-between" style={{ marginBottom: "0.5rem" }}>
          <button type="button" className="mini-calendar-nav-btn" disabled={expandedNavTargets ? !expandedNavTargets.canGoPrev : (collapsible && isAtCurrentMonth && !allowPastNavigation)} onClick={(e) => prevMonth(e)}>
            ‹
          </button>
          <button
            type="button"
            className="mini-calendar-month-btn"
            onClick={(e) => {
              e.stopPropagation();
              if (onMonthClick) onMonthClick();
              else goToday(e);
            }}
          >
            {slideMonthLabel}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
            {collapsible && !onMonthClick && (
              <button
                type="button"
                className="mini-calendar-nav-btn"
                onClick={() => onCollapsedChange?.(true)}
                aria-label={i18n.t("common:close")}
              >
                −
              </button>
            )}
            <button type="button" className="mini-calendar-nav-btn" disabled={expandedNavTargets ? !expandedNavTargets.canGoNext : false} onClick={(e) => nextMonth(e)}>
              ›
            </button>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
            gap: "0.15rem",
            textAlign: "center",
          }}
        >
          {dayNames.map((d) => (
            <div
              key={d}
              style={{
                fontSize: "0.7rem",
                color: "var(--text-dim)",
                padding: "0.2rem 0",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {d}
            </div>
          ))}
          {slideWeeks.flatMap((week) =>
            week.map((day) => {
              const isCurrentMonth = day.getMonth() === m;
              const isToday = sameDay(day, today);
              const isSelected = sameDay(day, selected);
              const hasEvents = eventDates?.has(dateToLocalYMD(day));
              const past = isPast(day, today);

              return (
                <button
                  key={day.toISOString()}
                  onClick={() => onSelect(day)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    aspectRatio: 1,
                    minWidth: 0,
                    background: isSelected
                      ? "var(--accent)"
                      : isToday
                        ? "var(--bg-hover)"
                        : "transparent",
                    color: isSelected
                      ? "#000"
                      : !isCurrentMonth
                        ? "var(--text-dim)"
                        : "var(--text)",
                    opacity: past && !isSelected ? 0.45 : 1,
                    border: "none",
                    borderRadius: "var(--radius-sm)",
                    padding: 0,
                    fontSize: "0.8rem",
                    cursor: "pointer",
                    fontWeight: isToday || isSelected ? 700 : 400,
                    position: "relative",
                  }}
                >
                  {day.getDate()}
                  {hasEvents && (
                    <span
                      style={{
                        position: "absolute",
                        bottom: 2,
                        left: "50%",
                        transform: "translateX(-50%)",
                        width: 4,
                        height: 4,
                        borderRadius: "50%",
                        background: isSelected ? "#000" : "var(--accent)",
                      }}
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  };

  const prevMonthYear = month === 0 ? year - 1 : year;
  const prevMonthMonth = month === 0 ? 11 : month - 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  const nextMonthMonth = month === 11 ? 0 : month + 1;

  const expandedContent = (
    <>
      {renderMonthSlide(prevMonthYear, prevMonthMonth)}
      {renderMonthSlide(year, month)}
      {renderMonthSlide(nextMonthYear, nextMonthMonth)}
    </>
  );

  return (
    <div
      ref={expandedRef}
      style={{ userSelect: "none" }}
      className={collapsible ? "mini-calendar-expanded" : ""}
    >
      {collapsible ? (
        <div
          data-expanded-slide-container
          style={{ overflow: "hidden", touchAction: "pan-y" }}
        >
          <div
            style={{
              display: "flex",
              width: "300%",
              transform: `translateX(calc(-33.333% + ${swipeOffset}px))`,
              transition: isResetting ? "none" : committingTo ? "transform 0.25s ease-out" : swipeOffset === 0 ? "transform 0.2s ease-out" : "none",
            }}
          >
            {expandedContent}
          </div>
        </div>
      ) : (
        <>
        <div className="flex items-center justify-between" style={{ marginBottom: "0.5rem" }}>
          <button type="button" className="mini-calendar-nav-btn" disabled={collapsible && isAtCurrentMonth} onClick={(e) => prevMonth(e)}>
            ‹
          </button>
          <button
            type="button"
            className="mini-calendar-month-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (onMonthClick) onMonthClick();
                else goToday(e);
              }}
            >
              {monthLabel}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
              <button type="button" className="mini-calendar-nav-btn" onClick={(e) => nextMonth(e)}>
                ›
              </button>
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gap: "0.15rem",
              textAlign: "center",
            }}
          >
            {dayNames.map((d) => (
              <div
                key={d}
                style={{
                  fontSize: "0.7rem",
                  color: "var(--text-dim)",
                  padding: "0.2rem 0",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {d}
              </div>
            ))}
            {weeks.flatMap((week) =>
              week.map((day) => {
                const isCurrentMonth = day.getMonth() === month;
                const isToday = sameDay(day, today);
                const isSelected = sameDay(day, selected);
                const hasEvents = eventDates?.has(dateToLocalYMD(day));
                const past = isPast(day, today);

                return (
                  <button
                    key={day.toISOString()}
                    onClick={() => onSelect(day)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      aspectRatio: 1,
                      minWidth: 0,
                      background: isSelected
                        ? "var(--accent)"
                        : isToday
                          ? "var(--bg-hover)"
                          : "transparent",
                      color: isSelected
                        ? "#000"
                        : !isCurrentMonth
                          ? "var(--text-dim)"
                          : "var(--text)",
                      opacity: past && !isSelected ? 0.45 : 1,
                      border: "none",
                      borderRadius: "var(--radius-sm)",
                      padding: 0,
                      fontSize: "0.8rem",
                      cursor: "pointer",
                      fontWeight: isToday || isSelected ? 700 : 400,
                      position: "relative",
                    }}
                  >
                    {day.getDate()}
                    {hasEvents && (
                      <span
                        style={{
                          position: "absolute",
                          bottom: 2,
                          left: "50%",
                          transform: "translateX(-50%)",
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: isSelected ? "#000" : "var(--accent)",
                        }}
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
