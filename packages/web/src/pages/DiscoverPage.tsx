import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { users as usersApi, federation, type User, type RemoteActor } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
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

/** Check if input looks like a remote handle or URL (for instant resolve) */
function looksLikeRemoteHandle(q: string): boolean {
  const t = q.trim();
  if (!t) return false;
  if (t.startsWith("https://") || t.startsWith("http://")) return true;
  return /^@?[^@\s]+@[^@\s]+$/.test(t);
}

export function DiscoverPage() {
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
        setSearchError(err instanceof Error ? err.message : "Could not resolve account");
      } finally {
        setSearching(false);
      }
    },
    [user, loadData]
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
      await federation.follow(actor.uri);
      setFollowedActorUris((prev) => new Set([...prev, actor.uri]));
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

  const isFollowed = (item: ProfileItem) =>
    item.kind === "local"
      ? followedLocalIds.has(item.user.id)
      : followedActorUris.has(item.actor.uri);

  const isOwn = (item: ProfileItem) =>
    item.kind === "local" && user && item.user.id === user.id;

  const filteredItems = allItems.filter((item) => {
    if (sourceFilter === "local" && item.kind !== "local") return false;
    if (sourceFilter === "remote" && item.kind !== "remote") return false;
    if (user && followFilter === "following" && !isFollowed(item)) return false;
    if (user && followFilter === "not_following" && isFollowed(item)) return false;
    return true;
  });

  const visibleItems =
    sortOrder === "recent"
      ? filteredItems
      : [...filteredItems].sort((a, b) => {
          const aFollowers = getFollowersCount(a) ?? -1;
          const bFollowers = getFollowersCount(b) ?? -1;
          const aEvents = getEventsCount(a) ?? -1;
          const bEvents = getEventsCount(b) ?? -1;
          if (sortOrder === "followers") return bFollowers - aFollowers;
          return bEvents - aEvents;
        });

  return (
    <div className="flex gap-2" style={{ alignItems: "flex-start" }}>
      {/* Sidebar */}
      <aside className="hide-mobile" style={{ flex: "0 0 220px", position: "sticky", top: "1rem" }}>
        {/* Source filter */}
        <div>
          <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
            Show
          </div>
          <button
            onClick={() => setSourceFilter("all")}
            className={sourceFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            All
          </button>
          <button
            onClick={() => setSourceFilter("local")}
            className={sourceFilter === "local" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            Local
          </button>
          <button
            onClick={() => setSourceFilter("remote")}
            className={sourceFilter === "remote" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginBottom: "0.3rem" }}
          >
            Remote
          </button>
        </div>
        {user && (
          <div style={{ marginTop: "1rem" }}>
            <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
              Following
            </div>
            <button
              onClick={() => setFollowFilter("all")}
              className={followFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
            >
              All
            </button>
            <button
              onClick={() => setFollowFilter("following")}
              className={followFilter === "following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
            >
              Following
            </button>
            <button
              onClick={() => setFollowFilter("not_following")}
              className={followFilter === "not_following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              style={{ marginBottom: "0.3rem" }}
            >
              Not following
            </button>
          </div>
        )}
        <div style={{ marginTop: "1rem" }}>
          <div className="text-sm text-dim" style={{ marginBottom: "0.3rem", fontWeight: 600 }}>
            Sort by
          </div>
          <button
            onClick={() => setSortOrder("recent")}
            className={sortOrder === "recent" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            Recent
          </button>
          <button
            onClick={() => setSortOrder("followers")}
            className={sortOrder === "followers" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginRight: "0.3rem", marginBottom: "0.3rem" }}
          >
            Most followers
          </button>
          <button
            onClick={() => setSortOrder("events")}
            className={sortOrder === "events" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            style={{ marginBottom: "0.3rem" }}
          >
            Most events
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1" style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "0.5rem" }}>
          Discover
        </h1>
        <p className="text-sm text-muted mb-2">
          Find and follow accounts from this server or from other federated servers (Mobilizon, Gancio, etc.).
        </p>

        {/* Unified search: filters local list; pasting @user@domain or URL resolves instantly */}
        <div className="field mb-2">
          <input
            placeholder="Search accounts or paste @user@domain / URL…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!user && (
          <p className="text-sm text-dim mb-2">Log in to resolve remote accounts by handle or URL.</p>
        )}
        {searching && <p className="text-sm text-muted mb-2">Resolving…</p>}
        {searchError && <p className="error-text mb-2">{searchError}</p>}

        {/* Mobile: filters */}
        <div className="show-mobile flex gap-1 flex-wrap mb-2">
          <button
            onClick={() => setSourceFilter("all")}
            className={sourceFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
          >
            All
          </button>
          <button
            onClick={() => setSourceFilter("local")}
            className={sourceFilter === "local" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
          >
            Local
          </button>
          <button
            onClick={() => setSourceFilter("remote")}
            className={sourceFilter === "remote" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
          >
            Remote
          </button>
          {user && (
            <>
              <span className="text-dim" style={{ alignSelf: "center", margin: "0 0.2rem" }}>·</span>
              <button
                onClick={() => setFollowFilter("all")}
                className={followFilter === "all" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              >
                All
              </button>
              <button
                onClick={() => setFollowFilter("following")}
                className={followFilter === "following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              >
                Following
              </button>
              <button
                onClick={() => setFollowFilter("not_following")}
                className={followFilter === "not_following" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
              >
                Not following
              </button>
            </>
          )}
          <span className="text-dim" style={{ alignSelf: "center", margin: "0 0.2rem" }}>·</span>
          <button
            onClick={() => setSortOrder("recent")}
            className={sortOrder === "recent" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
          >
            Recent
          </button>
          <button
            onClick={() => setSortOrder("followers")}
            className={sortOrder === "followers" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
          >
            Most followers
          </button>
          <button
            onClick={() => setSortOrder("events")}
            className={sortOrder === "events" ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
          >
            Most events
          </button>
        </div>

        {/* Remote resolve result (when newly discovered) */}
        {searchResult && !remoteActors.some((a) => a.uri === searchResult.uri) && (
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

        {loading ? (
          <p className="text-muted">Loading…</p>
        ) : visibleItems.length === 0 ? (
          <div className="empty-state">
            <p>No accounts found.</p>
            <p className="text-sm text-dim mt-1">
              {followFilter === "following"
                ? "You're not following anyone matching this filter yet."
                : followFilter === "not_following"
                  ? "You're following everyone matching this filter."
                  : sourceFilter === "remote"
                    ? "Paste a remote handle (e.g. @user@domain) or URL in the search bar to find accounts."
                    : sourceFilter === "local"
                      ? "No local accounts match your search."
                      : "Paste a remote handle or URL in the search bar, or try a different search."}
            </p>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
