import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MenuIcon, TrashIcon, XIcon } from "./icons";

const TAG_BATCH_SIZE = 60;
const SCROLL_CLOSE_RANGE = 120;

export interface TagsFoldRef {
  collapse: () => void;
  barElement: HTMLDivElement | null;
}

export interface TagsFoldProps {
  unfolded: boolean;
  onUnfoldedChange: (unfolded: boolean) => void;
  allTags: string[];
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  /** When true, use fixed positioning (homepage). When false, sticky (default). */
  fixed?: boolean;
  /** Returns calendar bar element — when tags unfolded and user scrolls, collapse if calendar reaches tags area */
  getCalendarBarElement?: () => HTMLElement | null;
  /** Called when user opens tags — parent can e.g. collapse calendar */
  onOpen?: () => void;
  /** Ref to ignore scroll collapse briefly (parent sets, e.g. when opening tags) */
  ignoreScrollUntilRef?: React.MutableRefObject<number>;
}

export const TagsFold = forwardRef<TagsFoldRef, TagsFoldProps>(function TagsFold(
  {
    unfolded,
    onUnfoldedChange,
    allTags,
    selectedTags,
    onToggleTag,
    onClearTags,
    fixed = false,
    getCalendarBarElement,
    onOpen,
    ignoreScrollUntilRef,
  },
  ref
) {
  const { t } = useTranslation(["common"]);
  const tagsBarRef = useRef<HTMLDivElement>(null);
  const tagsListRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const unfoldScrollYRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [collapseProgress, setCollapseProgress] = useState(0);
  const [visibleTagsCount, setVisibleTagsCount] = useState(TAG_BATCH_SIZE);

  useImperativeHandle(ref, () => ({
    collapse: () => {
      onUnfoldedChange(false);
      setCollapseProgress(0);
    },
    get barElement() {
      return tagsBarRef.current;
    },
  }), [onUnfoldedChange]);

  useEffect(() => {
    if (unfolded) {
      setVisibleTagsCount(TAG_BATCH_SIZE);
      setCollapseProgress(0);
      unfoldScrollYRef.current = typeof window !== "undefined" ? window.scrollY : 0;
      onOpen?.();
    }
  }, [unfolded, onOpen]);

  useEffect(() => {
    if (!unfolded) return;
    const handleScroll = () => {
      if (rafRef.current != null) return;
      if (ignoreScrollUntilRef && Date.now() < ignoreScrollUntilRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (ignoreScrollUntilRef && Date.now() < ignoreScrollUntilRef.current) return;
        const y = window.scrollY;
        const delta = y - unfoldScrollYRef.current;
        const progress = Math.min(Math.max(delta / SCROLL_CLOSE_RANGE, 0), 1);

        const tagsEl = tagsBarRef.current;
        const calendarEl = getCalendarBarElement?.();
        if (tagsEl && calendarEl) {
          const tagsRect = tagsEl.getBoundingClientRect();
          const calendarRect = calendarEl.getBoundingClientRect();
          if (calendarRect.top <= tagsRect.bottom + 20) {
            onUnfoldedChange(false);
            setCollapseProgress(0);
            return;
          }
        }

        setCollapseProgress(progress);
        if (progress >= 1) {
          onUnfoldedChange(false);
          setCollapseProgress(0);
        }
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [unfolded, onUnfoldedChange, getCalendarBarElement, ignoreScrollUntilRef]);

  useEffect(() => {
    if (!unfolded || visibleTagsCount >= allTags.length) return;
    const sentinel = loadMoreSentinelRef.current;
    const scrollRoot = tagsListRef.current;
    if (!sentinel || !scrollRoot) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleTagsCount((n) => Math.min(n + TAG_BATCH_SIZE, allTags.length));
        }
      },
      { root: scrollRoot, rootMargin: "100px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [unfolded, visibleTagsCount, allTags.length]);

  const handleOpen = useCallback(() => {
    onUnfoldedChange(true);
  }, [onUnfoldedChange]);

  const handleClose = useCallback(() => {
    onUnfoldedChange(false);
  }, [onUnfoldedChange]);

  /** Collapsed: selected first, then unselected — reorders on toggle, FLIP animates */
  const collapsedOrderTags = [...selectedTags, ...allTags.filter((t) => !selectedTags.includes(t))];
  /** Unfolded: stable order (allTags) — tags stay in place when toggling, no reshuffle */
  const unfoldedOrderTags = allTags;

  return (
    <>
      <div
        ref={tagsBarRef}
        className={`mobile-tags-fold ${fixed ? "mobile-tags-fold--fixed" : ""} ${unfolded ? "mobile-tags-fold--unfolded" : ""} ${collapseProgress > 0 ? "mobile-tags-fold--scroll-collapsing" : ""}`}
        style={
          unfolded && collapseProgress > 0 && typeof window !== "undefined"
            ? {
                ["--tags-collapse-progress" as string]: collapseProgress,
                height: collapseProgress >= 1 ? "68px" : `calc(68px + (min(80dvh, 600px) - 68px) * (1 - var(--tags-collapse-progress)))`,
                maxHeight: collapseProgress >= 1 ? "68px" : `calc(68px + (min(80dvh, 600px) - 68px) * (1 - var(--tags-collapse-progress)))`,
                paddingTop: `${0.2 + 0.3 * (1 - collapseProgress)}rem`,
                paddingBottom: `${0.4 + 0.35 * (1 - collapseProgress)}rem`,
              }
            : undefined
        }
      >
        {!unfolded && <span className="mobile-tags-fold__label">{t("tags")}</span>}
        <div className="mobile-tags-fold__row">
          {!unfolded && (
            <div className="mobile-tags-fold__scroll">
              <div className="mobile-tags-fold__inner">
                {selectedTags.length > 0 && (
                  <button type="button" onClick={onClearTags} className="tag tag-clear tag-clear-icon" aria-label={t("clear")}>
                    <TrashIcon />
                  </button>
                )}
                {collapsedOrderTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleTag(tag);
                    }}
                    className={`tag ${selectedTags.includes(tag) ? "tag-selected" : ""}`}
                    data-tag={tag}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}
          {unfolded && (
            <div className="mobile-tags-fold__expanded">
              <div className="mobile-tags-fold__expanded-header">
                <h2 className="mobile-tags-fold__headline">{t("tags")}</h2>
                <div className="mobile-tags-fold__header-actions">
                  <button
                    type="button"
                    className="mobile-tags-fold__toggle mobile-tags-fold__toggle-inline"
                    onClick={handleClose}
                    aria-expanded={true}
                    aria-label={t("close")}
                  >
                    <XIcon />
                  </button>
                </div>
              </div>
              <p className="mobile-tags-fold__description">{t("tagsDescription")}</p>
              <div ref={tagsListRef} className="mobile-tags-fold__list" onClick={(e) => e.stopPropagation()}>
                {unfoldedOrderTags.slice(0, visibleTagsCount).map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleTag(tag);
                    }}
                    className={`tag ${selectedTags.includes(tag) ? "tag-selected" : ""}`}
                    data-tag={tag}
                  >
                    {tag}
                  </button>
                ))}
                {visibleTagsCount < allTags.length && (
                  <div ref={loadMoreSentinelRef} className="mobile-tags-fold__sentinel" aria-hidden />
                )}
                {selectedTags.length > 0 && (
                  <button type="button" onClick={onClearTags} className="tag tag-clear tag-clear-icon" aria-label={t("clear")}>
                    <TrashIcon />
                  </button>
                )}
              </div>
            </div>
          )}
          {!unfolded && (
            <button
              type="button"
              className="mobile-tags-fold__toggle"
              onClick={handleOpen}
              aria-expanded={false}
              aria-label={t("unfoldTags")}
            >
              <MenuIcon />
            </button>
          )}
        </div>
      </div>
      {unfolded && (
        <div
          className={`mobile-tags-fold-spacer ${collapseProgress > 0 ? "mobile-tags-fold-spacer--no-transition" : ""}`}
          style={
            unfolded && typeof window !== "undefined"
              ? collapseProgress > 0
                ? {
                    ["--tags-collapse-progress" as string]: collapseProgress,
                    height: collapseProgress >= 1 ? "68px" : `calc(68px + (min(80dvh, 600px) - 68px) * (1 - var(--tags-collapse-progress)))`,
                  }
                : { height: "calc(min(80dvh, 600px) + 68px + 52px)" }
              : { height: "68px" }
          }
          aria-hidden
        />
      )}
    </>
  );
});
