import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { MiniCalendar } from "./MiniCalendar";

export interface MobileCalendarFoldRef {
  collapse: () => void;
  /** The calendar bar DOM element (for scroll-into-view etc.) */
  barElement: HTMLDivElement | null;
}

const SCROLL_CLOSE_RANGE = 120;
const FOLD_VIEWPORT_RATIO = 0.8;
const FOLD_MAX_HEIGHT = 600;

function foldExpandedMaxHeight(): number {
  if (typeof window === "undefined") return 600;
  return Math.min(window.innerHeight * FOLD_VIEWPORT_RATIO, FOLD_MAX_HEIGHT);
}

export interface MobileCalendarFoldProps {
  selectedDate: Date;
  onDateSelect: (date: Date) => void;
  eventDates: Set<string>;
  /** When true, calendar collapses on date select (mobile UX) */
  collapseOnSelect?: boolean;
  /** Optional: navigate by month instead of day when collapsed */
  onMonthNavigate?: (date: Date) => void;
  /** Optional: "go to today" when month label clicked in expanded view */
  onMonthClick?: () => void;
  /** Optional content below the calendar (e.g. scope toggle) */
  belowCalendar?: React.ReactNode;
  /** Height to add to minBarHeight when belowCalendar is present (e.g. scope toggle) */
  belowCalendarHeight?: number;
  /** Layout mode: "sticky" = bar in flow (e.g. profile), "fixed" = fixed below header (homepage), "in-flow" = relative when tags unfolded (homepage) */
  layout?: "sticky" | "fixed" | "in-flow";
  /** Ref to ignore scroll spy briefly (parent sets) */
  ignoreScrollSpyUntilRef?: React.MutableRefObject<number>;
  /** Ref to ignore scroll collapse briefly (parent sets) */
  ignoreScrollCollapseUntilRef?: React.MutableRefObject<number>;
  /** Called when expanded state changes (parent can use for overlay) */
  onExpandedChange?: (expanded: boolean) => void;
  /** When true, allow navigating to dates/months before known eventDates. */
  allowPastNavigation?: boolean;
}

export const MobileCalendarFold = forwardRef<MobileCalendarFoldRef, MobileCalendarFoldProps>(function MobileCalendarFold({
  selectedDate,
  onDateSelect,
  eventDates,
  collapseOnSelect = true,
  onMonthNavigate,
  onMonthClick,
  belowCalendar,
  belowCalendarHeight = 0,
  layout = "sticky",
  ignoreScrollSpyUntilRef,
  ignoreScrollCollapseUntilRef,
  onExpandedChange,
  allowPastNavigation = false,
}, ref) {
  const [calendarExpanded, setCalendarExpandedState] = useState(false);
  const setCalendarExpanded = useCallback(
    (expanded: boolean) => {
      setCalendarExpandedState(expanded);
      onExpandedChange?.(expanded);
    },
    [onExpandedChange]
  );
  const [calendarCollapseProgress, setCalendarCollapseProgress] = useState(0);
  const [calendarOpeningProgress, setCalendarOpeningProgress] = useState(1);

  const calendarBarRef = useRef<HTMLDivElement>(null);
  const calendarUnfoldScrollYRef = useRef(0);
  const calendarRafRef = useRef<number | null>(null);
  const calendarInteractionRef = useRef(false);

  useImperativeHandle(ref, () => ({
    collapse: () => {
      setCalendarExpanded(false);
      setCalendarCollapseProgress(0);
      setCalendarOpeningProgress(1);
    },
    get barElement() {
      return calendarBarRef.current;
    },
  }), [setCalendarExpanded]);

  const handleCalendarCollapsedChange = useCallback(
    (collapsed: boolean) => {
      const expanding = !collapsed;
      setCalendarExpanded(expanding);
      if (expanding) {
        ignoreScrollSpyUntilRef?.current && (ignoreScrollSpyUntilRef.current = Date.now() + 500);
      }
    },
    [ignoreScrollSpyUntilRef, setCalendarExpanded]
  );

  const handleDateSelect = useCallback(
    (date: Date) => {
      ignoreScrollSpyUntilRef?.current && (ignoreScrollSpyUntilRef.current = Date.now() + 600);
      onDateSelect(date);
      if (collapseOnSelect) {
        setCalendarExpanded(false);
        setCalendarCollapseProgress(0);
        setCalendarOpeningProgress(1);
      }
    },
    [onDateSelect, collapseOnSelect, ignoreScrollSpyUntilRef]
  );

  const handleMonthNavigate = useCallback(
    (date: Date) => {
      ignoreScrollSpyUntilRef?.current && (ignoreScrollSpyUntilRef.current = Date.now() + 600);
      ignoreScrollCollapseUntilRef?.current && (ignoreScrollCollapseUntilRef.current = Date.now() + 1200);
      if (onMonthNavigate) {
        onMonthNavigate(date);
      } else {
        onDateSelect(date);
      }
    },
    [onMonthNavigate, onDateSelect, ignoreScrollSpyUntilRef, ignoreScrollCollapseUntilRef]
  );

  const handleMonthClick = useCallback(() => {
    ignoreScrollSpyUntilRef?.current && (ignoreScrollSpyUntilRef.current = Date.now() + 600);
    ignoreScrollCollapseUntilRef?.current && (ignoreScrollCollapseUntilRef.current = Date.now() + 1200);
    if (onMonthClick) {
      onMonthClick();
    } else {
      onDateSelect(new Date());
    }
  }, [onMonthClick, onDateSelect, ignoreScrollSpyUntilRef, ignoreScrollCollapseUntilRef]);

  useEffect(() => {
    if (calendarExpanded) {
      setCalendarCollapseProgress(0);
      calendarUnfoldScrollYRef.current = typeof window !== "undefined" ? window.scrollY : 0;
      setCalendarOpeningProgress(1);
    }
  }, [calendarExpanded]);

  useEffect(() => {
    if (!calendarExpanded) return;
    const handleScroll = () => {
      if (calendarRafRef.current != null) return;
      if (calendarInteractionRef.current) return;
      if (ignoreScrollCollapseUntilRef && Date.now() < ignoreScrollCollapseUntilRef.current) return;
      calendarRafRef.current = requestAnimationFrame(() => {
        calendarRafRef.current = null;
        if (calendarInteractionRef.current) return;
        if (ignoreScrollCollapseUntilRef && Date.now() < ignoreScrollCollapseUntilRef.current) return;
        const y = window.scrollY;
        const delta = y - calendarUnfoldScrollYRef.current;
        const progress = Math.min(Math.max(delta / SCROLL_CLOSE_RANGE, 0), 1);
        setCalendarCollapseProgress(progress);
        if (progress > 0.02) {
          setCalendarExpanded(false);
          setCalendarCollapseProgress(0);
          setCalendarOpeningProgress(1);
        }
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (calendarRafRef.current != null) cancelAnimationFrame(calendarRafRef.current);
    };
  }, [calendarExpanded, ignoreScrollCollapseUntilRef]);

  useEffect(() => {
    const el = calendarBarRef.current;
    if (!el || calendarExpanded) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Element;
      const calendarScroll = el.querySelector(".mobile-calendar-fold-scroll");
      if (!calendarScroll?.contains(target)) return;
      if (target.closest(".mini-calendar-nav-btn")) return;
      e.preventDefault();
      e.stopPropagation();
      handleCalendarCollapsedChange(false);
    };
    el.addEventListener("click", handleClick, { capture: true });
    return () => el.removeEventListener("click", handleClick, { capture: true });
  }, [calendarExpanded, handleCalendarCollapsedChange]);

  const minBarHeight = 68 + belowCalendarHeight;
  const expandProgress = calendarOpeningProgress * (1 - calendarCollapseProgress);

  const layoutClasses =
    layout === "in-flow"
      ? "mobile-calendar-fold mobile-calendar-fold--in-flow"
      : layout === "fixed"
        ? "mobile-calendar-fold mobile-calendar-fold--sticky mobile-calendar-fold--fixed"
        : "mobile-calendar-fold mobile-calendar-fold--sticky";

  return (
    <>
      <div
        ref={calendarBarRef}
        className={`${layoutClasses} ${calendarExpanded ? "mobile-calendar-fold--unfolded" : ""} ${calendarCollapseProgress > 0 || calendarOpeningProgress < 1 ? "mobile-calendar-fold--scroll-collapsing" : ""}`}
        style={
          calendarExpanded && typeof window !== "undefined"
            ? {
                maxHeight: `${minBarHeight + (foldExpandedMaxHeight() - minBarHeight) * expandProgress}px`,
                ...(calendarCollapseProgress > 0 && {
                  paddingTop: `${0.2 + 0.3 * (1 - calendarCollapseProgress)}rem`,
                  paddingBottom: `${0.4 + 0.35 * (1 - calendarCollapseProgress)}rem`,
                }),
              }
            : undefined
        }
      >
        <div className="mobile-calendar-fold__inner-wrap">
          <div className="mobile-calendar-fold__row">
            {!calendarExpanded && (
              <div className="mobile-calendar-fold-scroll">
                <div className="mobile-calendar-fold__inner">
                  <MiniCalendar
                    selected={selectedDate}
                    onSelect={handleDateSelect}
                    eventDates={eventDates}
                    collapsible
                    collapsed={true}
                    onCollapsedChange={handleCalendarCollapsedChange}
                    navigateByDay
                    allowPastNavigation={allowPastNavigation}
                  />
                </div>
              </div>
            )}
            {calendarExpanded && (
              <div className="mobile-calendar-fold__expanded">
                <div className="mobile-calendar-fold__content">
                  <MiniCalendar
                    selected={selectedDate}
                    onSelect={handleDateSelect}
                    onMonthNavigate={handleMonthNavigate}
                    interactionRef={calendarInteractionRef}
                    eventDates={eventDates}
                    collapsible
                    collapsed={false}
                    onCollapsedChange={handleCalendarCollapsedChange}
                    onMonthClick={handleMonthClick}
                    allowPastNavigation={allowPastNavigation}
                  />
                </div>
              </div>
            )}
          </div>
          {belowCalendar && (
            <div className={`mobile-calendar-fold__below ${calendarExpanded ? "mobile-calendar-fold__below--sticky" : ""}`}>
              {belowCalendar}
            </div>
          )}
        </div>
      </div>
    </>
  );
});
