import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { federation, type RemoteActor } from "../lib/api";
import { useAuth } from "../hooks/useAuth";

export function FederationPage() {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [actor, setActor] = useState<RemoteActor | null>(null);
  const [searching, setSearching] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; total: number } | null>(null);
  const [followedActors, setFollowedActors] = useState<(RemoteActor & { followed?: boolean })[]>([]);
  const [knownActors, setKnownActors] = useState<RemoteActor[]>([]);

  // Load followed actors and known actors on mount
  useEffect(() => {
    federation.actors({ limit: 50 }).then((r) => setKnownActors(r.actors)).catch(() => {});
    if (user) {
      federation
        .followedActors()
        .then((r) => setFollowedActors(r.actors.map((a) => ({ ...a, followed: true }))))
        .catch(() => {});
    }
  }, [user]);

  const isFollowed = (uri: string) => followedActors.some((a) => a.uri === uri);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    setError(null);
    setActor(null);
    setResult(null);

    try {
      const res = await federation.search(query.trim());
      setActor(res.actor);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleFetch = async () => {
    if (!actor) return;
    setFetching(true);
    setError(null);
    setResult(null);

    try {
      const res = await federation.fetchActor(actor.uri);
      setResult({ imported: res.imported, total: res.total });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setFetching(false);
    }
  };

  const handleFollow = async (actorUri: string) => {
    if (!user) return;
    setFollowing(true);
    try {
      await federation.follow(actorUri);
      // Also import events
      await federation.fetchActor(actorUri);
      // Refresh followed list
      const res = await federation.followedActors();
      setFollowedActors(res.actors.map((a) => ({ ...a, followed: true })));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Follow failed");
    } finally {
      setFollowing(false);
    }
  };

  const handleUnfollow = async (actorUri: string) => {
    if (!user) return;
    try {
      await federation.unfollow(actorUri);
      setFollowedActors((prev) => prev.filter((a) => a.uri !== actorUri));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unfollow failed");
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "0.5rem" }}>Federation</h1>
      <p className="text-sm text-muted mb-2">
        Search for accounts on other servers (Mobilizon, Gancio, etc.) and follow them to import
        their events.
      </p>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-1 mb-2">
        <input
          placeholder="user@domain or https://..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" className="btn-primary" disabled={searching || !query.trim()}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="error-text mb-1">{error}</p>}

      {/* Search result */}
      {actor && (
        <div className="card mb-2">
          <ActorCard actor={actor} />
          <div className="flex items-center gap-1" style={{ marginTop: "0.75rem" }}>
            {user && !isFollowed(actor.uri) && (
              <button
                className="btn-primary btn-sm"
                onClick={() => handleFollow(actor.uri)}
                disabled={following}
              >
                {following ? "Following…" : "⊕ Follow & Import"}
              </button>
            )}
            {user && isFollowed(actor.uri) && (
              <button className="btn-ghost btn-sm" onClick={() => handleUnfollow(actor.uri)}>
                ✓ Following
              </button>
            )}
            <button className="btn-ghost btn-sm" onClick={handleFetch} disabled={fetching}>
              {fetching ? "Importing…" : "Import Events"}
            </button>
            {result && (
              <span className="text-sm text-muted">
                ✅ {result.imported} events imported
              </span>
            )}
          </div>
        </div>
      )}

      {/* Followed actors */}
      {followedActors.length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Followed Accounts
          </h2>
          <div className="flex flex-col gap-1">
            {followedActors.map((a) => (
              <div key={a.uri} className="card">
                <div className="flex items-center justify-between">
                  <ActorCard actor={a} compact />
                  <div className="flex gap-1">
                    <button
                      className="btn-ghost btn-sm"
                      onClick={async () => {
                        const res = await federation.fetchActor(a.uri);
                        alert(`Refreshed: ${res.imported} events imported`);
                      }}
                    >
                      ↻ Refresh
                    </button>
                    <button className="btn-ghost btn-sm" onClick={() => handleUnfollow(a.uri)}>
                      Unfollow
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Known actors (not followed) */}
      {knownActors.filter((a) => !isFollowed(a.uri)).length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Known Actors
          </h2>
          <p className="text-sm text-dim mb-1">
            Previously imported actors. Follow them to keep their events updated.
          </p>
          <div className="flex flex-col gap-1">
            {knownActors
              .filter((a) => !isFollowed(a.uri))
              .map((a) => (
                <div key={a.uri} className="card">
                  <div className="flex items-center justify-between">
                    <ActorCard actor={a} compact />
                    <div className="flex gap-1">
                      {user && (
                        <button
                          className="btn-primary btn-sm"
                          onClick={() => handleFollow(a.uri)}
                          disabled={following}
                        >
                          Follow
                        </button>
                      )}
                      <button
                        className="btn-ghost btn-sm"
                        onClick={async () => {
                          const res = await federation.fetchActor(a.uri);
                          alert(`Refreshed: ${res.imported} events imported`);
                        }}
                      >
                        Import
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Hint */}
      <div className="text-sm text-dim mt-2">
        <strong>Try it:</strong> Search for{" "}
        <button
          style={{
            border: "none",
            background: "none",
            color: "var(--accent)",
            cursor: "pointer",
            padding: 0,
            font: "inherit",
            textDecoration: "underline",
          }}
          onClick={() => setQuery("htubarrierefrei@events.htu.at")}
        >
          htubarrierefrei@events.htu.at
        </button>
      </div>
    </div>
  );
}

function ActorCard({ actor, compact }: { actor: RemoteActor; compact?: boolean }) {
  const size = compact ? 36 : 56;
  return (
    <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "var(--bg-hover)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: compact ? "1rem" : "1.5rem",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {actor.iconUrl ? (
          <img
            src={actor.iconUrl}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          actor.username[0]?.toUpperCase() || "?"
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: compact ? "0.9rem" : "1.1rem" }}>
          {actor.displayName || actor.username}
        </div>
        <div className="text-sm text-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          @{actor.username}@{actor.domain}
        </div>
        {!compact && actor.summary && (
          <p
            className="text-sm mt-1"
            style={{ maxHeight: "3em", overflow: "hidden" }}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(actor.summary, { ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "br", "p", "span"], ALLOWED_ATTR: ["href", "rel", "target"] }) }}
          />
        )}
      </div>
    </div>
  );
}
