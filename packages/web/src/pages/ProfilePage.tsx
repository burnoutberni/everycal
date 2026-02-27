import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { users as usersApi, federation, type User, type CalEvent } from "../lib/api";
import { dateToLocalYMD, endOfDayForApi, formatDateHeading, groupEventsByDate, startOfDayForApi, toLocalYMD } from "../lib/dateUtils";
import { profilePath } from "../lib/urls";
import { EventCard } from "../components/EventCard";
import { MiniCalendar } from "../components/MiniCalendar";
import { MobileCalendarFold, type MobileCalendarFoldRef } from "../components/MobileCalendarFold";
import { MobileHeaderContainer } from "../components/MobileHeaderContainer";
import { ProfileHeader } from "../components/ProfileHeader";
import { useAuth } from "../hooks/useAuth";
import { useDateScrollSpy } from "../hooks/useDateScrollSpy";
import { useIsMobile } from "../hooks/useIsMobile";

/** Linear collapse: progress 0→1 over this scroll range. Once 1, stay compact until header back in flow.
 *  Keep range short so collapse completes before date separator + first event card scroll out of view. */
const PROFILE_COLLAPSE_START = 2;
const PROFILE_COLLAPSE_RANGE = 20;
const PROFILE_EXPAND_AT_TOP = 18;
/** Only expand when header top > this — user scrolled back up. Stuck header ≈56px, natural position ≈80px. */
const PROFILE_EXPAND_HEADER_TOP = 70;

export interface ProfilePageSSRData {
  profile: User | null;
  events: CalEvent[];
  calendarEventDates: string[];
}

/** SSR wrapper for ProfilePage - uses preloaded data when available */
export function ProfilePage({ username, ssrData }: { username: string; ssrData?: ProfilePageSSRData }) {
  const { t, i18n } = useTranslation(["profile", "events", "common"]);
  const { user: currentUser } = useAuth();
  const [profile, setProfile] = useState<User | null>(ssrData?.profile ?? null);
  const [profileLoading, setProfileLoading] = useState(!ssrData);
  const [events, setEvents] = useState<CalEvent[]>(ssrData?.events ?? []);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [calendarEventDates, setCalendarEventDates] = useState<Set<string>>(
    ssrData?.calendarEventDates ? new Set(ssrData.calendarEventDates) : new Set()
  );

  // Fetch event dates for the minicalendar (visible grid)
  const calendarMonthRange = useMemo(() => {
    const y = selectedDate.getFullYear();
    const m = selectedDate.getMonth();
    const firstOfMonth = new Date(y, m, 1);
    const lastOfMonth = new Date(y, m + 1, 0);
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const firstVisible = new Date(y, m, 1 - startOffset);
    const endOffset = (7 - lastOfMonth.getDay()) % 7;
    const lastVisible = new Date(y, m + 1, 0 + endOffset);
    return { from: startOfDayForApi(firstVisible), to: endOfDayForApi(lastVisible) };
  }, [selectedDate]);

  const fetchProfile = useCallback(() => {
    setProfileLoading(true);
    usersApi
      .get(username)
      .then((p) => {
        setProfile(p);
      })
      .catch(() => setProfile(null))
      .finally(() => setProfileLoading(false));
  }, [username]);

  // Skip fetching if we have SSR data (profile is already loaded)
  useEffect(() => {
    if (ssrData?.profile) {
      setProfileLoading(false);
      return;
    }
    fetchProfile();
  }, [fetchProfile, ssrData?.profile]);

  useEffect(() => {
    let cancelled = false;
    const params = {
      from: calendarMonthRange.from,
      to: calendarMonthRange.to,
      limit: 500,
    };
    usersApi
      .events(username, params)
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
  }, [username, calendarMonthRange.from, calendarMonthRange.to, currentUser?.id]);

  const fetchEvents = useCallback(
    async () => {
      if (!profile) return;
      setEventsLoading(true);
      try {
        const res = await usersApi.events(username, {
          from: new Date().toISOString(),
          limit: 100,
          sort: "asc",
        });
        setEvents(res.events);
      } catch {
        setEvents([]);
      } finally {
        setEventsLoading(false);
      }
    },
    [username, profile, currentUser?.id]
  );

  useEffect(() => {
    // Skip fetching if we have SSR events data
    if (ssrData?.events && ssrData.events.length > 0) {
      return;
    }
    if (profile) fetchEvents();
  }, [profile, fetchEvents, ssrData?.events]);

  useEffect(() => {
    if (eventsLoading) {
      scrollSpyReadyRef.current = false;
      return;
    }
    const t = setTimeout(() => {
      scrollSpyReadyRef.current = true;
    }, 400);
    return () => clearTimeout(t);
  }, [eventsLoading]);

  const grouped = useMemo(() => groupEventsByDate(events, (e) => toLocalYMD(e.startDate)), [events]);
  const eventDatesFromList = useMemo(() => new Set(grouped.keys()), [grouped]);
  const isRemote = profile?.source === "remote";
  const isMobile = useIsMobile();
  const [profileCollapseProgress, setProfileCollapseProgress] = useState(0);
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const profileHeaderRef = useRef<HTMLDivElement>(null);
  const dateSectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const ignoreScrollSpyUntilRef = useRef(0);
  const ignoreScrollCollapseUntilRef = useRef(0);
  const scrollSpyReadyRef = useRef(false);
  const calendarFoldRef = useRef<MobileCalendarFoldRef>(null);
  const [listModal, setListModal] = useState<"followers" | "following" | null>(null);
  const [listUsers, setListUsers] = useState<User[]>([]);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    if (!listModal || !username) return;
    setListLoading(true);
    const api = listModal === "followers" ? usersApi.followers : usersApi.following;
    api(username)
      .then((res) => setListUsers(res.users))
      .catch(() => setListUsers([]))
      .finally(() => setListLoading(false));
  }, [listModal, username]);

  const profileCollapseRafRef = useRef<number | null>(null);
  const hasReachedCompactRef = useRef(false);
  useEffect(() => {
    const el = profileHeaderRef.current;
    if (!isMobile || !el) return;
    const updateProgress = () => {
      profileCollapseRafRef.current = null;
      const scrollY = typeof window !== "undefined" ? window.scrollY : 0;
      const headerTop = el.getBoundingClientRect().top;

      if (headerTop > PROFILE_EXPAND_HEADER_TOP) {
        hasReachedCompactRef.current = false;
        setProfileCollapseProgress(0);
        return;
      }

      if (hasReachedCompactRef.current) {
        setProfileCollapseProgress(1);
        return;
      }

      if (scrollY <= PROFILE_EXPAND_AT_TOP && headerTop >= PROFILE_EXPAND_HEADER_TOP) {
        hasReachedCompactRef.current = false;
        setProfileCollapseProgress(0);
        return;
      }

      const raw = (scrollY - PROFILE_COLLAPSE_START) / PROFILE_COLLAPSE_RANGE;
      const progress = Math.min(Math.max(raw, 0), 1);
      if (progress >= 1) hasReachedCompactRef.current = true;
      setProfileCollapseProgress(progress);
    };
    const handleScroll = () => {
      if (profileCollapseRafRef.current != null) return;
      profileCollapseRafRef.current = requestAnimationFrame(updateProgress);
    };
    updateProgress();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (profileCollapseRafRef.current != null) cancelAnimationFrame(profileCollapseRafRef.current);
    };
  }, [isMobile, profile]);

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
    triggerTop: 220,
    isReadyRef: scrollSpyReadyRef,
    enabled: isMobile,
  });

  const handleCalendarExpandedChange = useCallback((expanded: boolean) => {
    setCalendarExpanded(expanded);
    if (expanded) {
      ignoreScrollSpyUntilRef.current = Date.now() + 500;
    }
  }, []);

  const handleFollow = async () => {
    if (!profile) return;
    if (isRemote) {
      if (profile.following) {
        await federation.unfollow(profile.id);
      } else {
        await federation.follow(profile.id);
      }
    } else {
      if (profile.following) {
        await usersApi.unfollow(username);
      } else {
        await usersApi.follow(username);
      }
    }
    fetchProfile();
  };

  const handleAutoRepost = async () => {
    if (!profile || isRemote) return;
    if (profile.autoReposting) {
      await usersApi.removeAutoRepost(username);
    } else {
      await usersApi.autoRepost(username);
    }
    fetchProfile();
  };

  const [scrollToDate, setScrollToDate] = useState<string | null>(null);

  const handleDateSelect = (date: Date) => {
    setSelectedDate(date);
    setScrollToDate(dateToLocalYMD(date));
  };

  const handleDateSelectMobile = (date: Date) => {
    ignoreScrollSpyUntilRef.current = Date.now() + 600;
    setSelectedDate(date);
    setScrollToDate(dateToLocalYMD(date));
  };

  useEffect(() => {
    if (!scrollToDate || events.length === 0) return;
    const keys = [...grouped.keys()].sort();
    const idx = keys.findIndex((k) => k >= scrollToDate);
    const targetKey = idx >= 0 ? keys[idx] : keys[keys.length - 1];
    setScrollToDate(null);
    if (!targetKey) return;
    const [y, m, d] = targetKey.split("-").map(Number);
    setSelectedDate(new Date(y, m - 1, d));
    if (isMobile) {
      ignoreScrollSpyUntilRef.current = Date.now() + 800;
      ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
    }
    requestAnimationFrame(() => {
      const el = dateSectionRefs.current.get(targetKey);
      if (el) {
        el.style.scrollMarginTop = "calc(3.5rem + 52px + 68px + 2rem)";
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [scrollToDate, grouped, events.length, isMobile]);

  if (profileLoading) return <p className="text-muted">{t("common:loading")}</p>;
  if (!profile) return <p className="error-text">{t("userNotFound")}</p>;

  const isOwn = currentUser?.id === profile.id;

  return (
    <>
    <div className="flex gap-2" style={{ alignItems: "flex-start" }}>
      {/* Sidebar */}
      <aside className="hide-mobile" style={{ flex: "0 0 220px", position: "sticky", top: "1rem" }}>
        <MiniCalendar selected={selectedDate} onSelect={handleDateSelect} eventDates={calendarEventDates} />
      </aside>

      {/* Main content */}
      <div className="flex-1" style={{ minWidth: 0 }}>
        {isMobile ? (
          <MobileHeaderContainer paddingTop={`${0.2 * profileCollapseProgress}rem`}>
            <ProfileHeader
              profile={profile}
              currentUser={currentUser}
              isOwn={isOwn}
              isRemote={isRemote}
              collapseProgress={profileCollapseProgress}
              isMobile={isMobile}
              headerRef={profileHeaderRef}
              onFollow={handleFollow}
              onAutoRepost={handleAutoRepost}
              onOpenFollowers={() => setListModal("followers")}
              onOpenFollowing={() => setListModal("following")}
            />
            <div className="profile-mobile-calendar-wrap">
              <MobileCalendarFold
            ref={calendarFoldRef}
            selectedDate={selectedDate}
            onDateSelect={handleDateSelectMobile}
            eventDates={eventDatesFromList}
            collapseOnSelect
            layout="sticky"
            onMonthNavigate={(date) => {
              ignoreScrollSpyUntilRef.current = Date.now() + 600;
              ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
              setSelectedDate(date);
              setScrollToDate(dateToLocalYMD(date));
            }}
            onMonthClick={() => {
              ignoreScrollSpyUntilRef.current = Date.now() + 600;
              ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
              const today = new Date();
              setSelectedDate(today);
              setScrollToDate(dateToLocalYMD(today));
            }}
            ignoreScrollSpyUntilRef={ignoreScrollSpyUntilRef}
            ignoreScrollCollapseUntilRef={ignoreScrollCollapseUntilRef}
            onExpandedChange={handleCalendarExpandedChange}
          />
            </div>
          </MobileHeaderContainer>
        ) : (
          <ProfileHeader
            profile={profile}
            currentUser={currentUser}
            isOwn={isOwn}
            isRemote={isRemote}
            isMobile={false}
            onFollow={handleFollow}
            onAutoRepost={handleAutoRepost}
            onOpenFollowers={() => setListModal("followers")}
            onOpenFollowing={() => setListModal("following")}
          />
        )}

        {/* Event list */}
        <div className="profile-mobile-events-wrap">
          {eventsLoading ? (
            <p className="text-muted">{t("common:loading")}</p>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <p>{t("noEventsFound")}</p>
              <p className="text-sm text-dim mt-1">
                {t("noUpcomingFromAccount")}
              </p>
            </div>
          ) : (
            <>
              {[...grouped.entries()].map(([dateKey, dayEvents]) => (
                <div
                  key={dateKey}
                  ref={(el) => {
                    if (el) dateSectionRefs.current.set(dateKey, el);
                  }}
                  data-date={dateKey}
                  className="profile-date-section"
                  style={{ marginBottom: "1.25rem" }}
                >
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
                    {formatDateHeading(new Date(dateKey + "T00:00:00"), i18n.language)}
                  </h2>
                  <div className="flex flex-col gap-1">
                    {dayEvents.map((e) => (
                      <EventCard key={e.id} event={e} />
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
          {isMobile && calendarExpanded && (
            <div
              className="profile-mobile-events-overlay"
              onClick={() => calendarFoldRef.current?.collapse()}
              onKeyDown={(e) => e.key === "Enter" && calendarFoldRef.current?.collapse()}
              role="button"
              tabIndex={0}
              aria-label={t("common:close")}
            />
          )}
        </div>
        </div>
      </div>

      {/* Followers / Following modal (own profile or remote profile) */}
      {listModal && (isOwn || isRemote) && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && setListModal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="list-modal-title"
        >
          <div className="modal-card">
            <div className="modal-header">
              <h2 id="list-modal-title" style={{ fontSize: "1rem", fontWeight: 600 }}>
                {listModal === "followers" ? t("followersTitle") : t("followingTitle")}
              </h2>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setListModal(null)}
                aria-label={t("common:close")}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              {listLoading ? (
                <p className="text-muted">{t("common:loading")}</p>
              ) : listUsers.length === 0 ? (
                <p className="text-muted">
                  {listModal === "followers" ? t("noFollowers") : t("notFollowingAnyone")}
                </p>
              ) : (
                listUsers.map((u) => (
                  <div key={u.id} className="modal-user-row">
                    <Link
                      href={profilePath(u.username)}
                      style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: "0.75rem", textDecoration: "none", color: "inherit" }}
                      onClick={() => setListModal(null)}
                    >
                      <div className="avatar">
                        {u.avatarUrl ? (
                          <img src={u.avatarUrl} alt="" />
                        ) : (
                          (u.displayName || u.username || "?")[0].toUpperCase()
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {u.displayName || u.username}
                        </div>
                        <div className="text-muted" style={{ fontSize: "0.85rem" }}>
                          @{u.username}
                        </div>
                      </div>
                    </Link>
                    {listModal === "following" && isOwn && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={async (e) => {
                          e.preventDefault();
                          try {
                            if (u.source === "remote") {
                              await federation.unfollow(u.id);
                            } else {
                              await usersApi.unfollow(u.username);
                            }
                            setListUsers((prev) => prev.filter((x) => x.id !== u.id));
                            fetchProfile();
                          } catch {
                            // ignore
                          }
                        }}
                      >
                        {t("unfollow")}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
