import { useEffect, useState } from "react";
import { Link } from "wouter";
import { users as usersApi, type User } from "../lib/api";
import { profilePath } from "../lib/urls";

export function ExplorePage() {
  const [usersList, setUsersList] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"all" | "users" | "sources">("all");

  const search = (q: string) => {
    setLoading(true);
    usersApi
      .list({ q: q || undefined, limit: 100 })
      .then((r) => setUsersList(r.users))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    search("");
  }, []);

  const people = usersList.filter((u) => !u.isBot);
  const sources = usersList.filter((u) => u.isBot);

  const visible =
    tab === "users" ? people : tab === "sources" ? sources : usersList;

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1rem" }}>
        Explore
      </h1>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: "0.25rem",
          marginBottom: "1rem",
          borderBottom: "1px solid var(--border)",
          paddingBottom: 0,
        }}
      >
        {(
          [
            ["all", "All"],
            ["users", "Users"],
            ["sources", `Sources${sources.length ? ` (${sources.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: "0.5rem 1rem",
              background: "none",
              border: "none",
              borderBottom:
                tab === key
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
              color: tab === key ? "var(--fg)" : "var(--fg-muted)",
              fontWeight: tab === key ? 600 : 400,
              cursor: "pointer",
              fontSize: "0.9rem",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="field">
        <input
          placeholder={
            tab === "sources"
              ? "Search sources…"
              : tab === "users"
                ? "Search users…"
                : "Search users & sources…"
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            search(e.target.value);
          }}
        />
      </div>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <p>
            {tab === "sources"
              ? "No sources found."
              : tab === "users"
                ? "No users found."
                : "No results found."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((u) => (
            <Link key={u.id} href={profilePath(u.username)}>
              <div
                className="card flex items-center gap-2"
                style={{ cursor: "pointer" }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: u.isBot ? "8px" : "50%",
                    background: u.isBot
                      ? "var(--accent-bg, var(--bg-hover))"
                      : "var(--bg-hover)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "1.1rem",
                    flexShrink: 0,
                    overflow: "hidden",
                  }}
                >
                  {u.avatarUrl ? (
                    <img
                      src={u.avatarUrl}
                      alt=""
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                  ) : u.isBot ? (
                    <span style={{ fontSize: "1rem" }}>📡</span>
                  ) : (
                    u.username[0].toUpperCase()
                  )}
                </div>
                <div className="flex-1" style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                    }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {u.displayName || u.username}
                    </span>
                    {u.isBot && (
                      <span
                        style={{
                          fontSize: "0.65rem",
                          padding: "0.1rem 0.35rem",
                          borderRadius: "4px",
                          background: "var(--accent-bg, var(--bg-hover))",
                          color: "var(--accent, var(--fg-muted))",
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                          lineHeight: 1.4,
                        }}
                      >
                        SOURCE
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted">@{u.username}</div>
                </div>
                <div className="text-sm text-dim" style={{ whiteSpace: "nowrap" }}>
                  {u.followersCount} followers
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
