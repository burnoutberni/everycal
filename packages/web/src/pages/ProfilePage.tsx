import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { users as usersApi, federation, type User, type CalEvent } from "../lib/api";
import { sanitizeHtml } from "../lib/sanitize";
import { endOfDayForApi, startOfDayForApi, toLocalYMD } from "../lib/dateUtils";
import { profilePath } from "../lib/urls";
import { EventCard } from "../components/EventCard";
import { MiniCalendar } from "../components/MiniCalendar";
import { MenuIcon, RepostIcon } from "../components/icons";
import { useAuth } from "../hooks/useAuth";

function formatDateHeading(d: Date, locale?: string): string {
  return d.toLocaleDateString(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function groupByDate(events: CalEvent[]): Map<string, CalEvent[]> {
  const groups = new Map<string, CalEvent[]>();
  for (const ev of events) {
    const key = toLocalYMD(ev.startDate);
    const list = groups.get(key) || [];
    list.push(ev);
    groups.set(key, list);
  }
  return groups;
}

type RangeMode = "day" | "week" | "month" | "upcoming";

function getRangeDates(
  mode: RangeMode,
  selectedDate: Date,
  upcomingLabel: string,
  locale?: string
): { from: string; to?: string; label: string } {
  const y = selectedDate.getFullYear();
  const m = selectedDate.getMonth();
  const d = selectedDate.getDate();

  switch (mode) {
    case "day":
      return {
        from: startOfDayForApi(selectedDate),
        to: endOfDayForApi(selectedDate),
        label: formatDateHeading(selectedDate, locale),
      };
    case "week": {
      const dow = selectedDate.getDay() || 7;
      const monday = new Date(y, m, d - dow + 1);
      const sunday = new Date(y, m, d - dow + 7);
      return {
        from: startOfDayForApi(monday),
        to: endOfDayForApi(sunday),
        label: `${monday.toLocaleDateString(locale, { month: "short", day: "numeric" })} – ${sunday.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}`,
      };
    }
    case "month": {
      const first = new Date(y, m, 1);
      const last = new Date(y, m + 1, 0);
      return {
        from: startOfDayForApi(first),
        to: endOfDayForApi(last),
        label: selectedDate.toLocaleDateString(locale, { month: "long", year: "numeric" }),
      };
    }
    case "upcoming":
    default:
      return {
        from: new Date().toISOString(),
        label: upcomingLabel,
      };
  }
}

export function ProfilePage({ username }: { username: string }) {
  const { t, i18n } = useTranslation(["profile", "events", "common"]);
  const { user: currentUser } = useAuth();
  const [profile, setProfile] = useState<User | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [rangeMode, setRangeMode] = useState<RangeMode>("upcoming");
  const [calendarEventDates, setCalendarEventDates] = useState<Set<string>>(new Set());

  const range = useMemo(
    () => getRangeDates(rangeMode, selectedDate, t("events:upcoming"), i18n.language),
    [rangeMode, selectedDate, i18n.language, t]
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

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

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
        const params: { from?: string; to?: string; limit: number; sort?: "asc" | "desc" } = {
          limit: 100,
        };
        if (range.to) {
          params.from = range.from;
          params.to = range.to;
          params.sort = "asc";
        } else {
          params.from = range.from;
          params.sort = "asc";
        }
        const res = await usersApi.events(username, params);
        setEvents(res.events);
      } catch {
        setEvents([]);
      } finally {
        setEventsLoading(false);
      }
    },
    [username, profile, range, currentUser?.id]
  );

  useEffect(() => {
    if (profile) fetchEvents();
  }, [profile, fetchEvents]);

  const grouped = useMemo(() => groupByDate(events), [events]);
  const isRemote = profile?.source === "remote";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [listModal, setListModal] = useState<"followers" | "following" | null>(null);
  const [listUsers, setListUsers] = useState<User[]>([]);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (!listModal || !username) return;
    setListLoading(true);
    const api = listModal === "followers" ? usersApi.followers : usersApi.following;
    api(username)
      .then((res) => setListUsers(res.users))
      .catch(() => setListUsers([]))
      .finally(() => setListLoading(false));
  }, [listModal, username]);

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
        {/* Profile header */}
        <div className="card mb-2">
          <div className="flex items-center gap-2">
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: "var(--bg-hover)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.8rem",
                flexShrink: 0,
                overflow: "hidden",
              }}
            >
              {profile.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                profile.username[0].toUpperCase()
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-1" style={{ flexWrap: "wrap" }}>
                <h1 style={{ fontSize: "1.3rem", fontWeight: 700 }}>
                  {profile.displayName || profile.username}
                </h1>
                {currentUser && !isOwn && !isRemote && (
                  <div ref={menuRef} style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="profile-menu-btn"
                      onClick={() => setMenuOpen((o) => !o)}
                      aria-expanded={menuOpen}
                      aria-haspopup="true"
                      title={t("moreOptions")}
                    >
                      <MenuIcon />
                    </button>
                    {menuOpen && (
                      <div className="header-dropdown">
                        <button
                          type="button"
                          className="header-dropdown-item"
                          onClick={() => {
                            setMenuOpen(false);
                            handleAutoRepost();
                          }}
                          title={profile.autoReposting
                            ? t("stopAutoRepost")
                            : t("autoRepostAll")}
                          style={profile.autoReposting ? { color: "var(--accent)" } : undefined}
                        >
                          <RepostIcon />
                          {profile.autoReposting ? t("autoReposting") : t("autoRepost")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <p className="text-muted">@{profile.username}</p>
              {profile.bio && (
                <div
                  className="profile-bio mt-1"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeHtml(profile.bio.replace(/\n/g, "<br>")),
                  }}
                />
              )}
              {profile.website && (
                <p className="mt-1">
                  <a
                    href={profile.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--accent)" }}
                  >
                    🔗 {profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  </a>
                </p>
              )}
              <div className="flex gap-2 mt-1 text-sm text-muted">
                {(isOwn || isRemote) ? (
                  <>
                    <button
                      type="button"
                      className="profile-stat-clickable"
                      style={{ background: "none", border: "none", color: "inherit", padding: 0, font: "inherit" }}
                      onClick={() => setListModal("followers")}
                    >
                      <strong style={{ color: "var(--text)" }}>{profile.followersCount}</strong> {t("followers")}
                    </button>
                    <button
                      type="button"
                      className="profile-stat-clickable"
                      style={{ background: "none", border: "none", color: "inherit", padding: 0, font: "inherit" }}
                      onClick={() => setListModal("following")}
                    >
                      <strong style={{ color: "var(--text)" }}>{profile.followingCount}</strong> {t("following")}
                    </button>
                  </>
                ) : (
                  <>
                    <span>
                      <strong style={{ color: "var(--text)" }}>{profile.followersCount}</strong> {t("followers")}
                    </span>
                    <span>
                      <strong style={{ color: "var(--text)" }}>{profile.followingCount}</strong> {t("following")}
                    </span>
                  </>
                )}
              </div>
            </div>
            {currentUser && !isOwn && (
              <div style={{ flexShrink: 0 }}>
                <button
                  className={profile.following ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
                  onClick={handleFollow}
                >
                  {profile.following ? t("unfollow") : t("follow")}
                </button>
              </div>
            )}
          </div>
        </div>

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
                  {t(`events:${mode}`)}
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
                  {t("common:today")}
                </button>
              </div>
            )}
          </div>

          {/* Mobile: inline calendar */}
          <div className="show-mobile" style={{ marginBottom: "1rem" }}>
            <MiniCalendar selected={selectedDate} onSelect={handleDateSelect} eventDates={calendarEventDates} />
          </div>

          {/* Event list */}
          {eventsLoading ? (
            <p className="text-muted">{t("common:loading")}</p>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <p>{t("noEventsFound")}</p>
              <p className="text-sm text-dim mt-1">
                {rangeMode === "upcoming"
                  ? t("noUpcomingFromAccount")
                  : t("events:tryDifferentDate")}
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
