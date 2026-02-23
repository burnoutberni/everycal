import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { users as usersApi, federation, type User, type RemoteActor } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";
import { profilePath, remoteProfilePath } from "../lib/urls";
import {
  ProfileCard,
  ProfileCardContent,
  FollowButton,
  getProfileKey,
  getProfileHref,
  getFollowersCount,
  getEventsCount,
  type ProfileItem,
} from "../components/ProfileCard";
import { ChevronDownIcon, ChevronUpIcon } from "../components/icons";

/** Check if input looks like a remote handle or URL (for instant resolve) */
function looksLikeRemoteHandle(q: string): boolean {
  const t = q.trim();
  if (!t) return false;
  if (t.startsWith("https://") || t.startsWith("http://")) return true;
  return /^@?[^@\s]+@[^@\s]+$/.test(t);
}

/** Check if a profile item matches the search query (case-insensitive) */
function matchesSearch(item: ProfileItem, q: string): boolean {
  const lower = q.toLowerCase();
  if (item.kind === "local") {
    const u = item.user;
    return (
      (u.displayName?.toLowerCase()?.includes(lower)) ||
      (u.username?.toLowerCase()?.includes(lower))
    );
  }
  const a = item.actor;
  const handle = `@${a.username}@${a.domain}`.toLowerCase();
  return (
    (a.displayName?.toLowerCase()?.includes(lower)) ||
    (a.username?.toLowerCase()?.includes(lower)) ||
    (a.domain?.toLowerCase()?.includes(lower)) ||
    handle.includes(lower)
  );
}

export function DiscoverPage() {
  const { t } = useTranslation(["discover", "common"]);
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<RemoteActor | null>(null);
  const resolveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [localUsers, setLocalUsers] = useState<User[]>([]);
  const [remoteActors, setRemoteActors] = useState<RemoteActor[]>([]);
  const [followedLocalIds, setFollowedLocalIds] = useState<Set<string>>(new Set());
  const [followedActorUris, setFollowedActorUris] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [followBusy, setFollowBusy] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | "local" | "remote">("all");
  const [followFilter, setFollowFilter] = useState<"all" | "following" | "not_following">("all");
  const [sortOrder, setSortOrder] = useState<"recent" | "followers" | "events">("recent");
  const [hideZeroEvents, setHideZeroEvents] = useState(true);
  const [showHiddenSection, setShowHiddenSection] = useState(false);
  const [filtersUnfolded, setFiltersUnfolded] = useState(false);
  const isMobile = useIsMobile();
  const filtersBarRef = useRef<HTMLDivElement>(null);
  const filtersUnfoldScrollYRef = useRef(0);
  const filtersRafRef = useRef<number | null>(null);
  const ignoreFiltersScrollUntilRef = useRef(0);
  const [headerCollapseProgress, setHeaderCollapseProgress] = useState(0);
  const headerCollapseRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (filtersUnfolded) {
      filtersUnfoldScrollYRef.current = typeof window !== "undefined" ? window.scrollY : 0;
    }
  }, [filtersUnfolded]);

  useEffect(() => {
    if (!filtersUnfolded) return;
    const SCROLL_CLOSE_RANGE = 120;
    const handleScroll = () => {
      if (filtersRafRef.current != null) return;
      if (Date.now() < ignoreFiltersScrollUntilRef.current) return;
      filtersRafRef.current = requestAnimationFrame(() => {
        filtersRafRef.current = null;
        if (Date.now() < ignoreFiltersScrollUntilRef.current) return;
        const y = window.scrollY;
        const delta = y - filtersUnfoldScrollYRef.current;
        if (delta >= SCROLL_CLOSE_RANGE) {
          setFiltersUnfolded(false);
        }
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (filtersRafRef.current != null) cancelAnimationFrame(filtersRafRef.current);
    };
  }, [filtersUnfolded]);

  const openFilters = () => {
    ignoreFiltersScrollUntilRef.current = Date.now() + 300;
    setFiltersUnfolded(true);
  };

  const closeFilters = useCallback(() => {
    setFiltersUnfolded(false);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const COLLAPSE_START = 32;
    const COLLAPSE_RANGE = 96;
    const handleScroll = () => {
      if (headerCollapseRafRef.current != null) return;
      headerCollapseRafRef.current = requestAnimationFrame(() => {
        headerCollapseRafRef.current = null;
        const y = window.scrollY;
        const progress = Math.min(Math.max((y - COLLAPSE_START) / COLLAPSE_RANGE, 0), 1);
        setHeaderCollapseProgress(progress);
      });
    };
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (headerCollapseRafRef.current != null) cancelAnimationFrame(headerCollapseRafRef.current);
    };
  }, [isMobile]);

  // Collapse hidden section when search query changes
  useEffect(() => {
    setShowHiddenSection(false);
  }, [query]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const localQ = looksLikeRemoteHandle(query) ? undefined : (query.trim() || undefined);
      const [usersRes, actorsRes] = await Promise.all([
        usersApi.list({ q: localQ, limit: 100 }),
        federation.actors({ limit: 100 }),
      ]);
      setLocalUsers(usersRes.users);
      setRemoteActors(actorsRes.actors);

      if (user) {
        const [followingRes, followedRes] = await Promise.all([
          usersApi.following(user.username),
          federation.followedActors(),
        ]);
        setFollowedLocalIds(new Set(followingRes.users.map((u) => u.id)));
        setFollowedActorUris(new Set(followedRes.actors.map((a) => a.uri)));
      }
    } catch {
      setLocalUsers([]);
      setRemoteActors([]);
    } finally {
      setLoading(false);
    }
  }, [query, user]);

  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh stale remote actor data in background (when logged in)
  useEffect(() => {
    if (!user) return;
    federation
      .refreshActors({ limit: 20, maxAgeHours: 24 })
      .then((res) => {
        if (res.refreshed > 0 || (res.discovered ?? 0) > 0) loadDataRef.current();
      })
      .catch(() => {});
  }, [user]);

  const resolveRemote = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed || !user) return;

      setSearching(true);
      setSearchError(null);
      setSearchResult(null);

      try {
        const res = await federation.search(trimmed);
        setSearchResult(res.actor);
        await loadData();
      } catch (err: unknown) {
        setSearchError(err instanceof Error ? err.message : t("couldNotResolve"));
      } finally {
        setSearching(false);
      }
    },
    [user, loadData, t]
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (!looksLikeRemoteHandle(trimmed) || !user) {
      setSearchResult(null);
      setSearchError(null);
      return;
    }

    if (resolveTimeoutRef.current) clearTimeout(resolveTimeoutRef.current);
    resolveTimeoutRef.current = setTimeout(() => resolveRemote(trimmed), 400);
    return () => {
      if (resolveTimeoutRef.current) {
        clearTimeout(resolveTimeoutRef.current);
        resolveTimeoutRef.current = null;
      }
    };
  }, [query, user, resolveRemote]);

  const handleFollowLocal = async (u: User) => {
    if (!user || user.id === u.id) return;
    setFollowBusy(u.id);
    try {
      await usersApi.follow(u.username);
      setFollowedLocalIds((prev) => new Set([...prev, u.id]));
    } catch {
      // ignore
    } finally {
      setFollowBusy(null);
    }
  };

  const handleUnfollowLocal = async (u: User) => {
    if (!user) return;
    setFollowBusy(u.id);
    try {
      await usersApi.unfollow(u.username);
      setFollowedLocalIds((prev) => {
        const next = new Set(prev);
        next.delete(u.id);
        return next;
      });
    } catch {
      // ignore
    } finally {
      setFollowBusy(null);
    }
  };

  const handleFollowRemote = async (actor: RemoteActor) => {
    if (!user) return;
    setFollowBusy(actor.uri);
    try {
      const res = await federation.follow(actor.uri);
      if (res.delivered) {
        setFollowedActorUris((prev) => new Set([...prev, actor.uri]));
      }
    } catch {
      // ignore
    } finally {
      setFollowBusy(null);
    }
  };

  const handleUnfollowRemote = async (actor: RemoteActor) => {
    if (!user) return;
    setFollowBusy(actor.uri);
    try {
      await federation.unfollow(actor.uri);
      setFollowedActorUris((prev) => {
        const next = new Set(prev);
        next.delete(actor.uri);
        return next;
      });
    } catch {
      // ignore
    } finally {
      setFollowBusy(null);
    }
  };

  // Build unified list: local users + remote actors, deduplicated
  const allItems: ProfileItem[] = [];
  const seenRemote = new Set<string>();
  for (const u of localUsers) {
    allItems.push({ kind: "local", user: u });
  }
  for (const a of remoteActors) {
    if (!seenRemote.has(a.uri)) {
      seenRemote.add(a.uri);
      allItems.push({ kind: "remote", actor: a });
    }
  }

  // When searching by text (not handle/URL), filter by search term (local users are already filtered by API; remote actors need client-side filter)
  const trimmedQuery = query.trim();
  const isRemoteHandleSearch = trimmedQuery && looksLikeRemoteHandle(trimmedQuery);
  const searchFilteredItems =
    trimmedQuery && !isRemoteHandleSearch
      ? allItems.filter((item) => matchesSearch(item, trimmedQuery))
      : allItems;

  const isFollowed = (item: ProfileItem) =>
    item.kind === "local"
      ? followedLocalIds.has(item.user.id)
      : followedActorUris.has(item.actor.uri);

  const isOwn = (item: ProfileItem) =>
    item.kind === "local" && user && item.user.id === user.id;

  const filteredItems = searchFilteredItems.filter((item) => {
    if (sourceFilter === "local" && item.kind !== "local") return false;
    if (sourceFilter === "remote" && item.kind !== "remote") return false;
    if (user && followFilter === "following" && !isFollowed(item)) return false;
    if (user && followFilter === "not_following" && isFollowed(item)) return false;
    return true;
  });

  const hasZeroEvents = (item: ProfileItem) => getEventsCount(item) === 0;
  const itemsWithEvents = filteredItems.filter((item) => !hasZeroEvents(item));
  const itemsWithZeroEvents = filteredItems.filter(hasZeroEvents);

  const sortItems = (items: ProfileItem[]) =>
    sortOrder === "recent"
      ? items
      : [...items].sort((a, b) => {
          const aFollowers = getFollowersCount(a) ?? -1;
          const bFollowers = getFollowersCount(b) ?? -1;
          const aEvents = getEventsCount(a) ?? -1;
          const bEvents = getEventsCount(b) ?? -1;
          if (sortOrder === "followers") return bFollowers - aFollowers;
          return bEvents - aEvents;
        });

  const mainItems = hideZeroEvents ? itemsWithEvents : filteredItems;
  const visibleItems = sortItems(mainItems);
  const hiddenItems = sortItems(itemsWithZeroEvents);

  // When resolving by handle/URL: apply hideZeroEvents filter to search result too
  const searchResultItem = searchResult ? { kind: "remote" as const, actor: searchResult } : null;
  const searchResultHidden = searchResultItem && hideZeroEvents && getEventsCount(searchResultItem) === 0;

  return (
    <div className="flex gap-2" style={{ alignItems: "flex-start" }}>
      {/* Sidebar */}
      <aside className="hide-mobile" style={{ flex: "0 0 220px", position: "sticky", top: "1rem" }}>
        {/* Source filter */}
        <div>
          <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
            {t("common:show")}
          </div>
          <button
            onClick={() => setSourceFilter("all")}
            className={sourceFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            {t("all")}
          </button>
          <button
            onClick={() => setSourceFilter("local")}
            className={sourceFilter === "local" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            {t("local")}
          </button>
          <button
            onClick={() => setSourceFilter("remote")}
            className={sourceFilter === "remote" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginBottom: "0.3rem" }}
          >
            {t("remote")}
          </button>
        </div>
        {user && (
          <div style={{ marginTop: "1rem" }}>
            <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
              {t("following")}
            </div>
            <button
              onClick={() => setFollowFilter("all")}
              className={followFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
            >
              {t("all")}
            </button>
            <button
              onClick={() => setFollowFilter("following")}
              className={followFilter === "following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
            >
              {t("following")}
            </button>
            <button
              onClick={() => setFollowFilter("not_following")}
              className={followFilter === "not_following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              style={{ marginBottom: "0.3rem" }}
            >
              {t("notFollowing")}
            </button>
          </div>
        )}
        <div style={{ marginTop: "1rem" }}>
          <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
            {t("sortBy")}
          </div>
          <button
            onClick={() => setSortOrder("recent")}
            className={sortOrder === "recent" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            {t("recent")}
          </button>
          <button
            onClick={() => setSortOrder("followers")}
            className={sortOrder === "followers" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            {t("mostFollowers")}
          </button>
          <button
            onClick={() => setSortOrder("events")}
            className={sortOrder === "events" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginBottom: "0.3rem" }}
          >
            {t("mostEvents")}
          </button>
        </div>
        <div style={{ marginTop: "1rem" }}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={hideZeroEvents}
              onChange={(e) => setHideZeroEvents(e.target.checked)}
            />
            <span>{t("hideNoEvents")}</span>
          </label>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1" style={{ minWidth: 0 }}>
        {/* Header: h1, p, search, filters — on mobile: sticky, collapses on scroll */}
        <div
          className="discover-header"
          style={
            isMobile
              ? { ["--discover-collapse-progress" as string]: headerCollapseProgress }
              : undefined
          }
        >
          <div className="discover-mobile-hero">
            <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "0.5rem" }}>
              {t("title")}
            </h1>
            <p className="text-sm text-muted mb-2">
              {t("description")}
            </p>
          </div>
          <div className="discover-mobile-tools">
            {/* Unified search: filters local list; pasting @user@domain or URL resolves instantly */}
            <div className="field mb-2">
              <input
                placeholder={t("searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {!user && !isRemoteHandleSearch && (
              <p className="text-sm text-dim mb-2">{t("logInToResolve")}</p>
            )}
            {searching && <p className="text-sm text-muted mb-2">{t("resolving")}</p>}
            {searchError && <p className="error-text mb-2">{searchError}</p>}

            {/* Mobile: filters - fold-out behind toggle */}
            <div className="show-mobile discover-mobile-filters-wrap mb-2">
              <div
                ref={filtersBarRef}
                className={`discover-mobile-filters-bar ${filtersUnfolded ? "discover-mobile-filters-unfolded" : ""}`}
              >
                <div className={`discover-mobile-filters-row ${filtersUnfolded ? "discover-mobile-filters-row-expanded" : ""}`}>
              {!filtersUnfolded ? (
                <>
                  <span className="discover-mobile-filters-label">{t("filters")}</span>
                  <button
                    type="button"
                    className="discover-mobile-filters-toggle"
                    onClick={openFilters}
                    aria-expanded={false}
                    aria-label={t("filters")}
                  >
                    <ChevronDownIcon />
                  </button>
                </>
              ) : (
                <div className="discover-mobile-filters-expanded">
                  <div className="discover-mobile-filters-expanded-header">
                    <h2 className="discover-mobile-filters-headline">{t("filters")}</h2>
                    <button
                      type="button"
                      className="discover-mobile-filters-toggle discover-mobile-filters-toggle-inline"
                      onClick={() => setFiltersUnfolded(false)}
                      aria-expanded={true}
                      aria-label={t("common:close")}
                    >
                      <ChevronUpIcon />
                    </button>
                  </div>
                  <div className="discover-mobile-filters-content">
                    <div className="discover-mobile-filters-group">
                      <div className="discover-mobile-filters-group-label">{t("common:show")}</div>
                      <div className="discover-mobile-filters-buttons">
                        <button
                          onClick={() => setSourceFilter("all")}
                          className={sourceFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                        >
                          {t("all")}
                        </button>
                        <button
                          onClick={() => setSourceFilter("local")}
                          className={sourceFilter === "local" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                        >
                          {t("local")}
                        </button>
                        <button
                          onClick={() => setSourceFilter("remote")}
                          className={sourceFilter === "remote" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                        >
                          {t("remote")}
                        </button>
                      </div>
                    </div>
                    {user && (
                      <div className="discover-mobile-filters-group">
                        <div className="discover-mobile-filters-group-label">{t("following")}</div>
                        <div className="discover-mobile-filters-buttons">
                          <button
                            onClick={() => setFollowFilter("all")}
                            className={followFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                          >
                            {t("all")}
                          </button>
                          <button
                            onClick={() => setFollowFilter("following")}
                            className={followFilter === "following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                          >
                            {t("following")}
                          </button>
                          <button
                            onClick={() => setFollowFilter("not_following")}
                            className={followFilter === "not_following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                          >
                            {t("notFollowing")}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="discover-mobile-filters-group">
                      <div className="discover-mobile-filters-group-label">{t("sortBy")}</div>
                      <div className="discover-mobile-filters-buttons">
                        <button
                          onClick={() => setSortOrder("recent")}
                          className={sortOrder === "recent" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                        >
                          {t("recent")}
                        </button>
                        <button
                          onClick={() => setSortOrder("followers")}
                          className={sortOrder === "followers" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                        >
                          {t("mostFollowers")}
                        </button>
                        <button
                          onClick={() => setSortOrder("events")}
                          className={sortOrder === "events" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                        >
                          {t("mostEvents")}
                        </button>
                      </div>
                    </div>
                    <label className="checkbox-label" style={{ marginTop: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={hideZeroEvents}
                        onChange={(e) => setHideZeroEvents(e.target.checked)}
                      />
                      <span>{t("hideNoEvents")}</span>
                    </label>
                  </div>
                </div>
                )}
                </div>
              </div>
              {filtersUnfolded && (
                <div
                  className="discover-mobile-filters-spacer"
                  style={{ height: "calc(min(80dvh, 600px) + 2rem)" }}
                  aria-hidden
                />
              )}
            </div>
          </div>
        </div>

        {/* Content wrapper with overlay when filters unfolded */}
        <div className="discover-mobile-content-wrap">
        {/* Remote resolve result (when searching by handle/URL) */}
        {searchResult && isRemoteHandleSearch && !searchResultHidden && (
          <div className="card mb-3">
            <ProfileCard
              item={{ kind: "remote", actor: searchResult }}
              isFollowed={isFollowed({ kind: "remote", actor: searchResult })}
              isOwn={false}
              onFollow={() => handleFollowRemote(searchResult)}
              onUnfollow={() => handleUnfollowRemote(searchResult)}
              busy={followBusy === searchResult.uri}
              canFollow={!!user}
              profilePath={profilePath}
              remoteProfilePath={remoteProfilePath}
            />
          </div>
        )}

        {isRemoteHandleSearch ? (
          /* When searching for a remote handle, show only search result — not the full list */
          !user ? (
            <div className="empty-state">
              <p>{t("logInToResolve")}</p>
            </div>
          ) : searching ? (
            <p className="text-muted">{t("resolving")}</p>
          ) : searchError ? (
            <div className="empty-state">
              <p className="error-text mb-1">{searchError}</p>
              <p className="text-sm text-dim">{t("noAccountFoundForHandle")}</p>
            </div>
          ) : !searchResult ? (
            <div className="empty-state">
              <p>{t("noAccountFound")}</p>
              <p className="text-sm text-dim mt-1">{t("checkHandleAndTryAgain")}</p>
            </div>
          ) : searchResultHidden ? (
            /* Resolved account has 0 events and filter is on — show in collapsible section */
            <div className="mt-3">
              <button
                type="button"
                className="btn-ghost btn-sm text-dim"
                onClick={() => setShowHiddenSection((prev) => !prev)}
                style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}
              >
                {showHiddenSection ? "▼" : "▶"} {t("accountWithoutEvents", { count: 1 })}
              </button>
              {showHiddenSection && searchResultItem && (
                <div className="flex flex-col gap-1 mt-1">
                  <div className="card flex items-center gap-2">
                    <Link href={getProfileHref(searchResultItem, profilePath, remoteProfilePath)} style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                      <ProfileCardContent item={searchResultItem} profilePath={profilePath} remoteProfilePath={remoteProfilePath} />
                    </Link>
                    {user && (
                      <FollowButton
                        followed={isFollowed(searchResultItem)}
                        onFollow={() => handleFollowRemote(searchResult!)}
                        onUnfollow={() => handleUnfollowRemote(searchResult!)}
                        busy={followBusy === searchResult!.uri}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : null
        ) : loading ? (
          <p className="text-muted">{t("common:loading")}</p>
        ) : visibleItems.length === 0 && !(hideZeroEvents && hiddenItems.length > 0 && trimmedQuery) ? (
          <div className="empty-state">
            <p>{t("noAccountsFound")}</p>
            <p className="text-sm text-dim mt-1">
              {followFilter === "following"
                ? t("followFilterFollowing")
                : followFilter === "not_following"
                  ? t("followFilterNotFollowing")
                  : sourceFilter === "remote"
                    ? t("pasteRemoteHandle")
                    : sourceFilter === "local"
                      ? t("noLocalMatch")
                      : t("pasteRemoteOrTryDifferent")}
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              {visibleItems.map((item) => (
                <div key={getProfileKey(item)} className="card flex items-center gap-2">
                  <Link href={getProfileHref(item, profilePath, remoteProfilePath)} style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                    <ProfileCardContent item={item} profilePath={profilePath} remoteProfilePath={remoteProfilePath} />
                  </Link>
                  {user && !isOwn(item) && (
                    <FollowButton
                      followed={isFollowed(item)}
                      onFollow={() =>
                        item.kind === "local"
                          ? handleFollowLocal(item.user)
                          : handleFollowRemote(item.actor)
                      }
                      onUnfollow={() =>
                        item.kind === "local"
                          ? handleUnfollowLocal(item.user)
                          : handleUnfollowRemote(item.actor)
                      }
                      busy={followBusy === getProfileKey(item)}
                    />
                  )}
                </div>
              ))}
            </div>
            {hideZeroEvents && hiddenItems.length > 0 && trimmedQuery && (
              <div className="mt-3">
                <button
                  type="button"
                  className="btn-ghost btn-sm text-dim"
                  onClick={() => setShowHiddenSection((prev) => !prev)}
                  style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}
                >
                  {showHiddenSection ? "▼" : "▶"} {hiddenItems.length === 1
                    ? t("accountWithoutEvents", { count: 1 })
                    : t("accountsWithoutEvents", { count: hiddenItems.length })}
                </button>
                {showHiddenSection && (
                  <div className="flex flex-col gap-1 mt-1">
                    {hiddenItems.map((item) => (
                      <div key={getProfileKey(item)} className="card flex items-center gap-2">
                        <Link href={getProfileHref(item, profilePath, remoteProfilePath)} style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                          <ProfileCardContent item={item} profilePath={profilePath} remoteProfilePath={remoteProfilePath} />
                        </Link>
                        {user && !isOwn(item) && (
                          <FollowButton
                            followed={isFollowed(item)}
                            onFollow={() =>
                              item.kind === "local"
                                ? handleFollowLocal(item.user)
                                : handleFollowRemote(item.actor)
                            }
                            onUnfollow={() =>
                              item.kind === "local"
                                ? handleUnfollowLocal(item.user)
                                : handleUnfollowRemote(item.actor)
                            }
                            busy={followBusy === getProfileKey(item)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
          {isMobile && filtersUnfolded && (
            <div
              className="discover-mobile-content-overlay"
              onClick={closeFilters}
              onKeyDown={(e) => e.key === "Enter" && closeFilters()}
              role="button"
              tabIndex={0}
              aria-label={t("common:close")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
