import { useEffect, useState } from "react";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { EventCard } from "../components/EventCard";
import { useAuth } from "../hooks/useAuth";
import { Link } from "wouter";

export function TimelinePage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    eventsApi
      .timeline({ limit: 50 })
      .then((r) => setEvents(r.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  if (!user) {
    return (
      <div className="empty-state mt-3">
        <p>
          <Link href="/login">Log in</Link> to see your timeline.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1rem" }}>Your Timeline</h1>
      <p className="text-sm text-muted mb-2">Events from you and people you follow.</p>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : events.length === 0 ? (
        <div className="empty-state">
          <p>Nothing here yet.</p>
          <p className="text-sm text-dim mt-1">
            <Link href="/explore">Find people to follow</Link> or{" "}
            <Link href="/events/new">create an event</Link>.
          </p>
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
