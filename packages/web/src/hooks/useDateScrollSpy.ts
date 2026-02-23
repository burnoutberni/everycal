import { useEffect, RefObject } from "react";

export interface UseDateScrollSpyOptions {
  /** Map of date key (YYYY-MM-DD) to section element */
  dateSectionRefs: RefObject<Map<string, HTMLDivElement>>;
  /** Sorted date keys from the event list */
  dateKeys: string[];
  /** Called when the visible date section changes. Receives YYYY-MM-DD. */
  onVisibleDateChange: (ymd: string) => void;
  /** Ref to timestamp - updates are ignored until Date.now() > ref.current */
  ignoreUntilRef: RefObject<number>;
  /** Pixel offset from top - sections crossing this line are "visible" (default 240) */
  triggerTop?: number;
  /** Ref to predicate - return false to skip updates (e.g. when a fold is expanded) */
  shouldUpdateRef?: RefObject<() => boolean>;
  /** Ref to boolean - when false, skip updates (e.g. ProfilePage delays until scrollSpyReady) */
  isReadyRef?: RefObject<boolean>;
  /** When false, spy is disabled (e.g. ProfilePage only runs on mobile) */
  enabled?: boolean;
}

/**
 * Scroll spy: syncs the active date with the visible date section.
 * When user scrolls, the date that crosses the trigger line becomes active.
 */
export function useDateScrollSpy({
  dateSectionRefs,
  dateKeys,
  onVisibleDateChange,
  ignoreUntilRef,
  triggerTop = 240,
  shouldUpdateRef,
  isReadyRef,
  enabled = true,
}: UseDateScrollSpyOptions): void {
  useEffect(() => {
    if (!enabled || dateKeys.length === 0) return;

    const refs = dateSectionRefs.current;
    if (!refs) return;

    const updateActive = () => {
      if (shouldUpdateRef && !shouldUpdateRef.current?.()) return;
      if (isReadyRef && isReadyRef.current === false) return;

      const withVisibleContent = dateKeys
        .map((key) => {
          const el = refs.get(key);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { key, top: rect.top, bottom: rect.bottom };
        })
        .filter(
          (x): x is { key: string; top: number; bottom: number } =>
            x !== null && x.top <= triggerTop && x.bottom > triggerTop
        );

      let visibleKey: string | undefined;
      if (withVisibleContent.length > 0) {
        const best = withVisibleContent.sort((a, b) => b.top - a.top)[0];
        visibleKey = best.key;
      } else {
        const firstRect = refs.get(dateKeys[0])?.getBoundingClientRect();
        if (firstRect && firstRect.top > triggerTop) {
          visibleKey = dateKeys[0];
        } else {
          const nextSection = dateKeys
            .map((key) => {
              const el = refs.get(key);
              if (!el) return null;
              return { key, top: el.getBoundingClientRect().top };
            })
            .filter((x): x is { key: string; top: number } => x !== null && x.top > triggerTop)
            .sort((a, b) => a.top - b.top)[0];
          visibleKey = nextSection?.key ?? dateKeys[dateKeys.length - 1];
        }
      }

      if (!visibleKey || Date.now() < (ignoreUntilRef.current ?? 0)) return;
      onVisibleDateChange(visibleKey);
    };

    const observer = new IntersectionObserver(updateActive, {
      root: null,
      rootMargin: `-${triggerTop}px 0px 0px 0px`,
      threshold: [0, 0.1, 0.5, 1],
    });

    for (const key of dateKeys) {
      const el = refs.get(key);
      if (el) observer.observe(el);
    }

    const raf = requestAnimationFrame(updateActive);
    const scrollHandler = () => requestAnimationFrame(updateActive);
    window.addEventListener("scroll", scrollHandler, { passive: true });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", scrollHandler);
    };
  }, [dateSectionRefs, dateKeys, onVisibleDateChange, ignoreUntilRef, triggerTop, enabled]);
}
