import { useEffect, useState } from "react";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { EventCard } from "../components/EventCard";

export function HomePage() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    eventsApi
      .list({ from: new Date().toISOString(), limit: 30 })
      .then((r) => setEvents(r.events))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1rem" }}>Upcoming Events</h1>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : events.length === 0 ? (
        <div className="empty-state">
          <p>No upcoming events yet.</p>
          <p className="text-sm text-dim mt-1">
            Create one or wait for scrapers to import some!
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
