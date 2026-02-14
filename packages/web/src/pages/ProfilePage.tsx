import { useEffect, useState } from "react";
import { users as usersApi, type User, type CalEvent } from "../lib/api";
import { EventCard } from "../components/EventCard";
import { useAuth } from "../hooks/useAuth";

export function ProfilePage({ username }: { username: string }) {
  const { user: currentUser } = useAuth();
  const [profile, setProfile] = useState<User | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProfile = () => {
    Promise.all([usersApi.get(username), usersApi.events(username, { limit: 50 })])
      .then(([p, e]) => {
        setProfile(p);
        setEvents(e.events);
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
            <button
              className={profile.following ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
              onClick={handleFollow}
            >
              {profile.following ? "Unfollow" : "Follow"}
            </button>
          )}
        </div>
      </div>

      <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" }}>Events</h2>
      {events.length === 0 ? (
        <div className="empty-state">
          <p>No events yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {events.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      )}
    </div>
  );
}
