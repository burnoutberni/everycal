import { useEffect, useState } from "react";
import { Link } from "wouter";
import { users as usersApi, type User } from "../lib/api";

export function ExplorePage() {
  const [usersList, setUsersList] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const search = (q: string) => {
    setLoading(true);
    usersApi
      .list({ q: q || undefined, limit: 50 })
      .then((r) => setUsersList(r.users))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    search("");
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1rem" }}>Explore</h1>

      <div className="field">
        <input
          placeholder="Search users…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            search(e.target.value);
          }}
        />
      </div>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : usersList.length === 0 ? (
        <div className="empty-state">
          <p>No users found.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {usersList.map((u) => (
            <Link key={u.id} href={`/users/${u.username}`}>
              <div className="card flex items-center gap-2" style={{ cursor: "pointer" }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "var(--bg-hover)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "1.1rem",
                    flexShrink: 0,
                    overflow: "hidden",
                  }}
                >
                  {u.avatarUrl ? (
                    <img src={u.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    u.username[0].toUpperCase()
                  )}
                </div>
                <div className="flex-1">
                  <div style={{ fontWeight: 600 }}>{u.displayName || u.username}</div>
                  <div className="text-sm text-muted">@{u.username}</div>
                </div>
                <div className="text-sm text-dim">
                  {u.followersCount} followers · {u.followingCount} following
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
