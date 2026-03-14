import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { isValidHttpUrl, normalizeHttpUrlInput } from "@everycal/core";
import { auth as authApi, identities as identitiesApi, users as usersApi, federation, uploads, type User, type CalEvent, type PublishingIdentity } from "../lib/api";
import { validateAvatarUpload } from "../lib/avatarUpload";
import { dateToLocalYMD, endOfDayForApi, groupEventsByDate, parseLocalYmdDate, resolveNearestDateKey, startOfDayForApi, toLocalYMD } from "../lib/dateUtils";
import { profilePath } from "../lib/urls";
import { DateEventSection } from "../components/DateEventSection";
import { EventCard } from "../components/EventCard";
import { MiniCalendar } from "../components/MiniCalendar";
import { MobileCalendarFold, type MobileCalendarFoldRef } from "../components/MobileCalendarFold";
import { MobileHeaderContainer } from "../components/MobileHeaderContainer";
import { ProfileHeader, type InlineProfileDraft } from "../components/ProfileHeader";
import { ActAsActionModal } from "../components/ActAsActionModal";
import { useAuth } from "../hooks/useAuth";
import { useHasAdditionalIdentities } from "../hooks/useHasAdditionalIdentities";
import { useDateScrollSpy } from "../hooks/useDateScrollSpy";
import { useIsMobile } from "../hooks/useIsMobile";
import { useOptionalPageContext } from "../renderer/PageContext";

/** Mobile profile header collapse threshold.
 *  At/near top we keep header expanded; after this offset it snaps compact and stays compact
 *  until explicitly expanded (or user returns to top in upcoming mode). */
const PROFILE_COLLAPSE_START = 2;

export function ProfilePage({ username }: { username: string }) {
  const { t, i18n } = useTranslation(["profile", "events", "common", "settings", "auth"]);
  const { user: currentUser, refreshUser } = useAuth();
  const [, setLocation] = useLocation();
  const allowLocalhostUrls = typeof window !== "undefined"
    && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

  // Use SSR initial context if available
  const pageContext = useOptionalPageContext();
  const initialProfile = ((pageContext?.data as any)?.profile ?? null) as User | null;
  const initialEvents = (((pageContext?.data as any)?.events ?? []) as CalEvent[]);

  const [profile, setProfile] = useState<User | null>(initialProfile);
  const [profileLoading, setProfileLoading] = useState(!initialProfile);
  const [events, setEvents] = useState<CalEvent[]>(initialEvents);
  const [eventsLoading, setEventsLoading] = useState(!initialEvents.length);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [rangeFromOverride, setRangeFromOverride] = useState<string | null>(null);
  const viewingPast = rangeFromOverride != null;
  const [calendarEventDates, setCalendarEventDates] = useState<Set<string>>(new Set());
  const fetchRequestIdRef = useRef(0);
  const eventsRef = useRef(events);
  const [socialModal, setSocialModal] = useState<null | "follow" | "autoRepost">(null);
  const [socialActionError, setSocialActionError] = useState<string | null>(null);
  const { hasAdditionalIdentities, loading: identitiesLoading } = useHasAdditionalIdentities();
  const didAutoSelectUpcomingRef = useRef(false);

  const range = useMemo(() => {
    if (rangeFromOverride) {
      const parsed = parseLocalYmdDate(rangeFromOverride);
      return { from: parsed ? startOfDayForApi(parsed) : rangeFromOverride, to: undefined as string | undefined };
    }
    return { from: new Date().toISOString(), to: undefined as string | undefined };
  }, [rangeFromOverride]);

  // Fetch event dates for minicalendar navigation + dots.
  const calendarMonthRange = useMemo(() => {
    const safeSelectedDate = Number.isNaN(selectedDate.getTime()) ? new Date() : selectedDate;
    const y = safeSelectedDate.getFullYear();
    const m = safeSelectedDate.getMonth();
    const firstOfMonth = new Date(y, m, 1);
    const lastOfMonth = new Date(y, m + 1, 0);
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const firstVisible = new Date(y, m, 1 - startOffset);
    const endOffset = (7 - lastOfMonth.getDay()) % 7;
    const lastVisible = new Date(y, m + 1, 0 + endOffset);
    const extendedFrom = new Date(firstVisible);
    extendedFrom.setMonth(extendedFrom.getMonth() - 2);
    const extendedTo = new Date(lastVisible);
    extendedTo.setMonth(extendedTo.getMonth() + 2);
    return { from: startOfDayForApi(extendedFrom), to: endOfDayForApi(extendedTo) };
  }, [selectedDate]);

  const normalizeAndValidateUrl = useCallback(
    (value: string, errorKey: "settings:invalidWebsiteUrl" | "settings:invalidAvatarUrl") => {
      const normalized = normalizeHttpUrlInput(value);
      if (!normalized) return { normalized: "", error: undefined as string | undefined };
      if (!isValidHttpUrl(normalized, { allowLocalhost: allowLocalhostUrls })) return { normalized, error: t(errorKey) };
      return { normalized, error: undefined as string | undefined };
    },
    [allowLocalhostUrls, t]
  );

  const validateWebsite = useCallback(
    (value: string) => normalizeAndValidateUrl(value, "settings:invalidWebsiteUrl"),
    [normalizeAndValidateUrl]
  );

  const validateAvatar = useCallback(
    (value: string) => normalizeAndValidateUrl(value, "settings:invalidAvatarUrl"),
    [normalizeAndValidateUrl]
  );

  const normalizeAvatarForApi = useCallback((value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (typeof window !== "undefined") {
      try {
        const parsed = new URL(trimmed, window.location.origin);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          return parsed.toString();
        }
      } catch {
        // fall back to text normalization below
      }
    }
    return normalizeHttpUrlInput(trimmed);
  }, []);

  const fetchProfile = useCallback((force = false) => {
    if (!force && profile?.username === username) return;
    setProfileLoading(true);
    usersApi
      .get(username)
      .then((p) => {
        setProfile(p);
      })
      .catch(() => setProfile(null))
      .finally(() => setProfileLoading(false));
  }, [username, profile?.username]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    if (!currentUser || !profile || profile.source === "remote" || profile.accountType !== "identity") {
      setManagedIdentity(null);
      return;
    }
    let cancelled = false;
    identitiesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const found = res.identities.find((identity) => identity.username === profile.username) || null;
        setManagedIdentity(found && (found.role === "editor" || found.role === "owner") ? found : null);
      })
      .catch(() => {
        if (!cancelled) setManagedIdentity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, profile?.id, profile?.username, profile?.source, profile?.accountType]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

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
      const currentEvents = eventsRef.current;
      const todayYmd = dateToLocalYMD(new Date());
      const hasPastInLoaded = currentEvents.some((event) => toLocalYMD(event.startDate) < todayYmd);
      if (!viewingPast && currentEvents.length > 0 && String(currentEvents[0]?.accountId) === profile.id && !hasPastInLoaded) return; // Skip if loaded via SSR

      const requestId = ++fetchRequestIdRef.current;

      setEventsLoading(true);
      try {
        const res = await usersApi.events(username, {
          from: range.from,
          to: range.to,
          limit: 100,
          sort: "asc",
        });
        if (requestId !== fetchRequestIdRef.current) return;
        setEvents(res.events);
      } catch {
        if (requestId !== fetchRequestIdRef.current) return;
        setEvents([]);
      } finally {
        if (requestId !== fetchRequestIdRef.current) return;
        setEventsLoading(false);
      }
    },
    [username, profile, currentUser?.id, viewingPast, range.from, range.to]
  );

  useEffect(() => {
    if (profile) fetchEvents();
  }, [profile, fetchEvents]);

  useEffect(() => {
    if (eventsLoading && events.length === 0) {
      scrollSpyReadyRef.current = false;
      return;
    }
    const t = setTimeout(() => {
      scrollSpyReadyRef.current = true;
    }, 400);
    return () => clearTimeout(t);
  }, [eventsLoading, events.length]);

  const grouped = useMemo(() => groupEventsByDate(events, (e) => toLocalYMD(e.startDate)), [events]);
  const navigableEventDates = useMemo(() => {
    const set = new Set(calendarEventDates);
    for (const key of grouped.keys()) set.add(key);
    return set;
  }, [calendarEventDates, grouped]);
  const todayYmd = dateToLocalYMD(new Date());
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
  const [managedIdentity, setManagedIdentity] = useState<PublishingIdentity | null>(null);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileEditorMode, setProfileEditorMode] = useState<"person" | "identity" | null>(null);
  const [profileEditorBusy, setProfileEditorBusy] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarTouched, setAvatarTouched] = useState(false);
  const [profileEditorError, setProfileEditorError] = useState<string | null>(null);
  const [inlineDraft, setInlineDraft] = useState<InlineProfileDraft | null>(null);
  const [initialAvatarUrl, setInitialAvatarUrl] = useState("");
  const [profileFormErrors, setProfileFormErrors] = useState<{ website?: string; avatarUrl?: string }>({});

  useEffect(() => {
    setProfileEditing(false);
    setProfileEditorMode(null);
    setInlineDraft(null);
    setInitialAvatarUrl("");
    setAvatarUploading(false);
    setAvatarTouched(false);
    setProfileEditorError(null);
    setProfileFormErrors({});
    didAutoSelectUpcomingRef.current = false;
  }, [username]);

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
      const nowTs = Date.now();
      const scrollY = typeof window !== "undefined" ? window.scrollY : 0;

      if (viewingPast) {
        hasReachedCompactRef.current = true;
        setProfileCollapseProgress(1);
        return;
      }

      if (nowTs < ignoreScrollCollapseUntilRef.current) {
        if (hasReachedCompactRef.current) {
          setProfileCollapseProgress(1);
        }
        return;
      }

      if (profileEditing) {
        hasReachedCompactRef.current = false;
        setProfileCollapseProgress(0);
        return;
      }

      if (hasReachedCompactRef.current) {
        setProfileCollapseProgress(1);
        return;
      }

      if (scrollY <= PROFILE_COLLAPSE_START) {
        setProfileCollapseProgress(0);
        return;
      }

      hasReachedCompactRef.current = true;
      setProfileCollapseProgress(1);
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
  }, [isMobile, profile, profileEditing, viewingPast]);

  const dateKeys = useMemo(() => [...grouped.keys()].sort(), [grouped]);
  useDateScrollSpy({
    dateSectionRefs,
    dateKeys,
    onVisibleDateChange: useCallback((ymd: string) => {
      const parsed = parseLocalYmdDate(ymd);
      if (!parsed) return;
      setSelectedDate((prev) => {
        if (prev.getFullYear() === parsed.getFullYear() && prev.getMonth() === parsed.getMonth() && prev.getDate() === parsed.getDate()) return prev;
        return parsed;
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

  const handleProfileHeaderExpand = useCallback(() => {
    const sticky = document.querySelector(".mobile-header-container") as HTMLElement | null;
    const beforeHeight = sticky?.getBoundingClientRect().height ?? 0;
    ignoreScrollSpyUntilRef.current = Date.now() + 1200;
    hasReachedCompactRef.current = false;
    setProfileCollapseProgress(0);
    ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const afterHeight = sticky?.getBoundingClientRect().height ?? 0;
        const delta = Math.round(afterHeight - beforeHeight);
        if (delta > 0) {
          window.scrollBy({ top: -delta, behavior: "auto" });
        }
      });
    });
  }, []);

  const isOwn = currentUser?.id === profile?.id;
  const canEditProfile = !!profile && !isRemote && (isOwn || !!managedIdentity);
  const canCreateEvents = canEditProfile;
  const effectiveCollapseProgress = profileEditing ? 0 : profileCollapseProgress;

  const openProfileEditor = useCallback(async () => {
    if (!profile || isRemote) return;
    setProfileEditorError(null);
    setProfileFormErrors({});
    try {
      if (isOwn) {
        const me = await authApi.me();
        setProfileEditorMode("person");
        setInlineDraft({
          displayName: me.displayName || "",
          bio: me.bio || "",
          website: me.website || "",
          avatarUrl: me.avatarUrl || "",
        });
        setInitialAvatarUrl(me.avatarUrl || "");
      } else if (managedIdentity) {
        const res = await identitiesApi.list();
        const identity = res.identities.find((item) => item.username === managedIdentity.username);
        if (!identity) {
          setProfileEditorError(t("settings:identityActionFailed"));
          return;
        }
        setManagedIdentity(identity);
        setProfileEditorMode("identity");
        setInlineDraft({
          displayName: identity.displayName || "",
          bio: identity.bio || "",
          website: identity.website || "",
          avatarUrl: identity.avatarUrl || "",
        });
        setInitialAvatarUrl(identity.avatarUrl || "");
      } else {
        return;
      }
      setAvatarTouched(false);
      setProfileEditing(true);
    } catch (err: unknown) {
      setProfileEditorError((err as Error).message || t("common:requestFailed"));
    }
  }, [profile, isRemote, isOwn, managedIdentity, t]);

  useEffect(() => {
    if (!canEditProfile || profileEditing) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("edit") !== "1") return;
    openProfileEditor().finally(() => {
      params.delete("edit");
      const next = params.toString();
      setLocation(`${window.location.pathname}${next ? `?${next}` : ""}`, { replace: true });
    });
  }, [canEditProfile, profileEditing, openProfileEditor, setLocation]);

  const handleSaveProfileEditor = useCallback(async () => {
    if (!profileEditorMode || !profile || !inlineDraft) return;
    setProfileEditorError(null);
    const websiteResult = validateWebsite(inlineDraft.website);
    const avatarNormalized = normalizeAvatarForApi(inlineDraft.avatarUrl);
    const initialAvatarNormalized = normalizeAvatarForApi(initialAvatarUrl);
    const avatarChanged = avatarTouched && avatarNormalized !== initialAvatarNormalized;
    const avatarResult = avatarChanged
      ? validateAvatar(avatarNormalized)
      : { normalized: avatarNormalized, error: undefined as string | undefined };
    const nextErrors = {
      website: websiteResult.error,
      avatarUrl: avatarChanged ? avatarResult.error : undefined,
    };
    setProfileFormErrors(nextErrors);
    setInlineDraft((prev) => (prev
      ? {
          ...prev,
          website: websiteResult.normalized,
          avatarUrl: avatarChanged ? avatarResult.normalized : prev.avatarUrl,
        }
      : prev));
    if (nextErrors.website || nextErrors.avatarUrl) return;

    setProfileEditorBusy(true);
    try {
      if (profileEditorMode === "person") {
        await authApi.updateProfile({
          displayName: inlineDraft.displayName,
          bio: inlineDraft.bio,
          website: websiteResult.normalized,
          ...(avatarChanged ? { avatarUrl: avatarResult.normalized || "" } : {}),
        });
        await refreshUser();
      } else if (managedIdentity) {
        const res = await identitiesApi.update(managedIdentity.username, {
          displayName: inlineDraft.displayName || undefined,
          bio: inlineDraft.bio || undefined,
          website: websiteResult.normalized || null,
          ...(avatarChanged ? { avatarUrl: avatarResult.normalized || null } : {}),
        });
        setManagedIdentity(res.identity);
      }
      await fetchProfile(true);
      setProfileEditing(false);
    } catch (err: unknown) {
      setProfileEditorError((err as Error).message || t("common:requestFailed"));
    } finally {
      setProfileEditorBusy(false);
    }
  }, [profileEditorMode, profile, inlineDraft, validateWebsite, validateAvatar, normalizeAvatarForApi, initialAvatarUrl, avatarTouched, managedIdentity, fetchProfile, t, refreshUser]);

  const handleInlineAvatarUpload = useCallback(async (file: File) => {
    setProfileEditorError(null);
    const uploadErrorKey = validateAvatarUpload(file);
    if (uploadErrorKey) {
      setProfileEditorError(t(uploadErrorKey, { maxMb: 5 }));
      return;
    }
    setAvatarUploading(true);
    try {
      const result = await uploads.upload(file);
      setAvatarTouched(true);
      setInlineDraft((prev) => (prev ? { ...prev, avatarUrl: result.url } : prev));
    } catch (err: unknown) {
      setProfileEditorError((err as Error).message || t("profile:avatarUploadFailed"));
    } finally {
      setAvatarUploading(false);
    }
  }, [t]);

  const handleFollow = async () => {
    if (!profile) return;
    setSocialActionError(null);
    try {
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
      fetchProfile(true);
    } catch {
      setSocialActionError(t("common:requestFailed"));
    }
  };

  const handleAutoRepost = async () => {
    if (!profile || isRemote) return;
    setSocialActionError(null);
    try {
      if (profile.autoReposting) {
        await usersApi.removeAutoRepost(username);
      } else {
        await usersApi.autoRepost(username);
      }
      fetchProfile(true);
    } catch {
      setSocialActionError(t("common:requestFailed"));
    }
  };

  const handleCancelProfileEditor = useCallback(() => {
    setProfileEditing(false);
    setAvatarTouched(false);
    setProfileEditorError(null);
    setProfileFormErrors({});
  }, []);

  const [scrollToDate, setScrollToDate] = useState<string | null>(null);

  const handleDateSelect = (date: Date) => {
    if (Number.isNaN(date.getTime())) return;
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
    setSelectedDate(date);
    setScrollToDate(dateToLocalYMD(date));
  };

  const handleDateSelectMobile = (date: Date) => {
    if (Number.isNaN(date.getTime())) return;
    ignoreScrollSpyUntilRef.current = Date.now() + 600;
    ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
    hasReachedCompactRef.current = true;
    setProfileCollapseProgress(1);
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
    setSelectedDate(date);
    setScrollToDate(dateToLocalYMD(date));
  };

  useEffect(() => {
    if (!scrollToDate || events.length === 0) return;
    const keys = [...grouped.keys()].sort();
    const todayYmd = dateToLocalYMD(new Date());
    const hasTargetRangeData = viewingPast
      ? keys.some((k) => k < todayYmd)
      : keys.some((k) => k >= todayYmd);
    if (!hasTargetRangeData) return;

    const hasExactDate = keys.includes(scrollToDate);
    const isKnownCalendarDate = navigableEventDates.has(scrollToDate);
    if (viewingPast && !hasExactDate && isKnownCalendarDate) return;

    const targetKey = viewingPast
      ? (hasExactDate ? scrollToDate : resolveNearestDateKey(keys, scrollToDate, true))
      : hasExactDate
        ? scrollToDate
        : resolveNearestDateKey(keys, scrollToDate, false);
    setScrollToDate(null);
    if (!targetKey) return;
    if (isMobile) {
      ignoreScrollSpyUntilRef.current = Date.now() + 800;
      ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
    }
    requestAnimationFrame(() => {
      const el = dateSectionRefs.current.get(targetKey);
      if (el) {
        if (isMobile) {
          const appHeaderHeight = (document.querySelector(".app-header") as HTMLElement | null)?.offsetHeight ?? 56;
          const stickyProfileHeight = (document.querySelector(".mobile-header-container") as HTMLElement | null)?.offsetHeight ?? 120;
          const dynamicOffset = appHeaderHeight + stickyProfileHeight + 12;
          const targetTop = Math.max(0, Math.round(window.scrollY + el.getBoundingClientRect().top - dynamicOffset));
          if (Math.abs(window.scrollY - targetTop) > 1) {
            window.scrollTo({ top: targetTop, behavior: "auto" });
          }
        } else {
          el.style.scrollMarginTop = "calc(3.5rem + 1rem)";
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
  }, [scrollToDate, grouped, events.length, isMobile, viewingPast, navigableEventDates]);

  useEffect(() => {
    if (viewingPast || eventsLoading || grouped.size === 0 || didAutoSelectUpcomingRef.current) return;
    const todayYmd = dateToLocalYMD(new Date());
    const selectedYmd = dateToLocalYMD(selectedDate);
    if (selectedYmd !== todayYmd) {
      didAutoSelectUpcomingRef.current = true;
      return;
    }
    if (grouped.has(todayYmd)) {
      didAutoSelectUpcomingRef.current = true;
      return;
    }
    const sortedKeys = [...grouped.keys()].sort();
    const firstUpcoming = sortedKeys.find((k) => k >= todayYmd) || sortedKeys[0];
    if (!firstUpcoming) return;
    const parsed = parseLocalYmdDate(firstUpcoming);
    if (!parsed) return;
    setSelectedDate(parsed);
    setScrollToDate(firstUpcoming);
    didAutoSelectUpcomingRef.current = true;
  }, [viewingPast, eventsLoading, grouped, selectedDate]);

  if (profileLoading) return <p className="text-muted">{t("common:loading")}</p>;
  if (!profile) return <p className="error-text">{t("userNotFound")}</p>;

  return (
    <>
      <div className="flex gap-2" style={{ alignItems: "flex-start" }}>
        {/* Sidebar */}
        <aside className="hide-mobile" style={{ flex: "0 0 220px", position: "sticky", top: "1rem" }}>
          <MiniCalendar selected={selectedDate} onSelect={handleDateSelect} eventDates={navigableEventDates} allowPastNavigation />
        </aside>

        {/* Main content */}
        <div className="flex-1" style={{ minWidth: 0 }}>
          {isMobile ? (
            <MobileHeaderContainer>
              <ProfileHeader
                profile={profile}
                currentUser={currentUser}
                isOwn={isOwn}
                isRemote={isRemote}
                collapseProgress={effectiveCollapseProgress}
                isMobile={isMobile}
                headerRef={profileHeaderRef}
                onFollow={handleFollow}
                onAutoRepost={handleAutoRepost}
                onFollowAs={() => {
                  setSocialActionError(null);
                  setSocialModal("follow");
                }}
                onAutoRepostAs={() => {
                  setSocialActionError(null);
                  setSocialModal("autoRepost");
                }}
                showIdentityActions={!identitiesLoading && hasAdditionalIdentities}
                onOpenFollowers={() => setListModal("followers")}
                onOpenFollowing={() => setListModal("following")}
                canEditProfile={canEditProfile}
                onEditProfile={openProfileEditor}
                editingProfile={profileEditing}
                inlineDraft={inlineDraft || undefined}
                onInlineDraftChange={(next) => {
                  setInlineDraft((prev) => {
                    if (prev && prev.avatarUrl !== next.avatarUrl) setAvatarTouched(true);
                    return next;
                  });
                }}
                onSaveInline={handleSaveProfileEditor}
                onCancelInline={handleCancelProfileEditor}
                inlineBusy={profileEditorBusy}
                inlineError={profileEditorError || profileFormErrors.website || profileFormErrors.avatarUrl || null}
                onInlineAvatarUpload={handleInlineAvatarUpload}
                avatarUploading={avatarUploading}
                onRequestExpand={handleProfileHeaderExpand}
              />
              {!profileEditing && (
                <div className="profile-mobile-calendar-wrap">
                  <MobileCalendarFold
                    ref={calendarFoldRef}
                    selectedDate={selectedDate}
                    onDateSelect={handleDateSelectMobile}
                    eventDates={navigableEventDates}
                    allowPastNavigation
                    collapseOnSelect
                    layout="sticky"
                    onMonthNavigate={(date) => {
                      handleDateSelectMobile(date);
                    }}
                    onMonthClick={() => {
                      ignoreScrollSpyUntilRef.current = Date.now() + 600;
                      ignoreScrollCollapseUntilRef.current = Date.now() + 1200;
                      const today = new Date();
                      setRangeFromOverride(null);
                      setSelectedDate(today);
                      setScrollToDate(dateToLocalYMD(today));
                    }}
                    ignoreScrollSpyUntilRef={ignoreScrollSpyUntilRef}
                    ignoreScrollCollapseUntilRef={ignoreScrollCollapseUntilRef}
                    onExpandedChange={handleCalendarExpandedChange}
                  />
                </div>
              )}
            </MobileHeaderContainer>
          ) : (
            <div style={{ marginBottom: "0.8rem" }}>
              <ProfileHeader
                profile={profile}
                currentUser={currentUser}
                isOwn={isOwn}
                isRemote={isRemote}
                isMobile={false}
                onFollow={handleFollow}
                onAutoRepost={handleAutoRepost}
                onFollowAs={() => {
                  setSocialActionError(null);
                  setSocialModal("follow");
                }}
                onAutoRepostAs={() => {
                  setSocialActionError(null);
                  setSocialModal("autoRepost");
                }}
                showIdentityActions={!identitiesLoading && hasAdditionalIdentities}
                onOpenFollowers={() => setListModal("followers")}
                onOpenFollowing={() => setListModal("following")}
                canEditProfile={canEditProfile}
                onEditProfile={openProfileEditor}
                editingProfile={profileEditing}
                inlineDraft={inlineDraft || undefined}
                onInlineDraftChange={(next) => {
                  setInlineDraft((prev) => {
                    if (prev && prev.avatarUrl !== next.avatarUrl) setAvatarTouched(true);
                    return next;
                  });
                }}
                onSaveInline={handleSaveProfileEditor}
                onCancelInline={handleCancelProfileEditor}
                inlineBusy={profileEditorBusy}
                inlineError={profileEditorError || profileFormErrors.website || profileFormErrors.avatarUrl || null}
                onInlineAvatarUpload={handleInlineAvatarUpload}
                avatarUploading={avatarUploading}
              />
            </div>
          )}

          {/* Event list */}
          <div className="profile-mobile-events-wrap">
            {socialActionError && <p className="error-text mb-2" role="alert">{socialActionError}</p>}
            {eventsLoading && events.length === 0 ? (
              <p className="text-muted">{t("common:loading")}</p>
            ) : events.length === 0 ? (
              <div className="empty-state">
                <p>{t("noEventsFound")}</p>
                <p className="text-sm text-dim mt-1">
                  {t("noUpcomingFromAccount")}
                </p>
                {canCreateEvents && (
                  <div className="mt-2">
                    <Link href="/create" className="btn-primary btn-sm">
                      {t("common:createNewEvent")}
                    </Link>
                  </div>
                )}
              </div>
            ) : (
              <>
                {[...grouped.entries()].map(([dateKey, dayEvents]) => (
                  <DateEventSection
                    key={dateKey}
                    dateKey={dateKey}
                    locale={i18n.language}
                    isPast={dateKey < todayYmd}
                    pastLabel={t("events:past")}
                    sectionClassName="profile-date-section"
                    setSectionRef={(el) => {
                      if (el) dateSectionRefs.current.set(dateKey, el);
                    }}
                  >
                    {dayEvents.map((e) => (
                      <EventCard key={e.id} event={e} />
                    ))}
                  </DateEventSection>
                ))}
              </>
            )}
            {isMobile && !profileEditing && calendarExpanded && (
              <div
                className="profile-mobile-events-overlay"
                onClick={() => calendarFoldRef.current?.collapse()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    calendarFoldRef.current?.collapse();
                  }
                }}
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
                            fetchProfile(true);
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

      {socialModal === "follow" && profile && currentUser && !isOwn && (
        <ActAsActionModal
          open
          onClose={() => setSocialModal(null)}
          onComplete={(errorMessage) => setSocialActionError(errorMessage)}
          excludedAccountIds={isRemote ? undefined : [profile.id]}
          actionKind="follow"
          loadState={() => (
            isRemote
              ? federation.followActors(profile.id)
              : usersApi.followActors(username)
          )}
          apply={(desiredAccountIds) => (
            isRemote
              ? federation.setFollowActors(profile.id, desiredAccountIds)
              : usersApi.setFollowActors(username, desiredAccountIds)
          )}
        />
      )}

      {socialModal === "autoRepost" && profile && currentUser && !isOwn && !isRemote && (
        <ActAsActionModal
          open
          onClose={() => setSocialModal(null)}
          onComplete={(errorMessage) => setSocialActionError(errorMessage)}
          excludedAccountIds={[profile.id]}
          actionKind="autoRepost"
          loadState={() => usersApi.autoRepostActors(username)}
          apply={(desiredAccountIds) => usersApi.setAutoRepostActors(username, desiredAccountIds)}
        />
      )}
    </>
  );
}
