import { useEffect, useState } from "react";
import { users as usersApi, type User, type CalEvent } from "../lib/api";
import { EventCard } from "../components/EventCard";
import { useAuth } from "../hooks/useAuth";

function groupEvents(events: CalEvent[]): { upcoming: CalEvent[]; past: CalEvent[] } {
  const now = Date.now();
  const current: CalEvent[] = [];
  const future: CalEvent[] = [];
  const past: CalEvent[] = [];

  for (const e of events) {
    const start = new Date(e.startDate).getTime();
    const end = e.endDate ? new Date(e.endDate).getTime() : start;
    if (start <= now && end >= now) {
      current.push(e);
    } else if (start > now) {
      future.push(e);
    } else {
      past.push(e);
    }
  }

  // Current: sort by start ascending
  current.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  // Future: nearest first
  future.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  // Past: most recent first
  past.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());

  return { upcoming: [...current, ...future], past };
}

export function ProfilePage({ username }: { username: string }) {
  const { user: currentUser } = useAuth();
  const [profile, setProfile] = useState<User | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProfile = () => {
    const now = new Date().toISOString();
    // Fetch profile, upcoming events (ASC), and recent past events (DESC)
    Promise.all([
      usersApi.get(username),
      usersApi.events(username, { from: now, limit: 50 }),
      usersApi.events(username, { to: now, limit: 20, sort: "desc" }),
    ])
      .then(([p, upcoming, past]) => {
        setProfile(p);
        // Combine and deduplicate by ID
        const combined = new Map<string, CalEvent>();
        upcoming.events.forEach((e) => combined.set(e.id, e));
        past.events.forEach((e) => combined.set(e.id, e));
        setEvents(Array.from(combined.values()));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    loadProfile();
  }, [username]);

  const handleFollow = async () => {
    if (!profile) return;
    if (profile.following) {
      await usersApi.unfollow(username);
    } else {
      await usersApi.follow(username);
    }
    loadProfile();
  };

  const handleAutoRepost = async () => {
    if (!profile) return;
    if (profile.autoReposting) {
      await usersApi.removeAutoRepost(username);
    } else {
      await usersApi.autoRepost(username);
    }
    loadProfile();
  };

  if (loading) return <p className="text-muted">Loading…</p>;
  if (!profile) return <p className="error-text">User not found.</p>;

  const isOwn = currentUser?.id === profile.id;

  return (
    <div>
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
            <h1 style={{ fontSize: "1.3rem", fontWeight: 700 }}>
              {profile.displayName || profile.username}
            </h1>
            <p className="text-muted">@{profile.username}</p>
            {profile.bio && <p className="mt-1">{profile.bio}</p>}
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
              <span>
                <strong style={{ color: "var(--text)" }}>{profile.followersCount}</strong> followers
              </span>
              <span>
                <strong style={{ color: "var(--text)" }}>{profile.followingCount}</strong> following
              </span>
            </div>
          </div>
          {currentUser && !isOwn && (
            <div className="flex flex-col gap-1" style={{ alignItems: "flex-end" }}>
              <button
                className={profile.following ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
                onClick={handleFollow}
              >
                {profile.following ? "Unfollow" : "Follow"}
              </button>
              <button
                className={profile.autoReposting ? "btn-ghost btn-sm" : "btn-ghost btn-sm"}
                onClick={handleAutoRepost}
                title={profile.autoReposting
                  ? "Stop auto-reposting all events from this account"
                  : "Automatically repost all events from this account onto your feed"}
                style={profile.autoReposting ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
              >
                🔁 {profile.autoReposting ? "Auto-reposting" : "Auto-repost"}
              </button>
            </div>
          )}
        </div>
      </div>

      {events.length === 0 ? (
        <>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" }}>Events</h2>
          <div className="empty-state">
            <p>No events yet.</p>
          </div>
        </>
      ) : (() => {
        const { upcoming, past } = groupEvents(events);
        return (
          <>
            <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" }}>Upcoming Events</h2>
            {upcoming.length > 0 ? (
              <div className="flex flex-col gap-1">
                {upcoming.map((e) => (
                  <EventCard key={e.id} event={e} />
                ))}
              </div>
            ) : (
              <p className="text-muted" style={{ marginBottom: "1rem" }}>No upcoming events.</p>
            )}
            {past.length > 0 && (
              <>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginTop: "1.5rem", marginBottom: "0.75rem" }}>Past Events</h2>
                <div className="flex flex-col gap-1">
                  {past.map((e) => (
                    <EventCard key={e.id} event={e} />
                  ))}
                </div>
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}
