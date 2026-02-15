import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { events as eventsApi, type CalEvent, type EventInput } from "../lib/api";
import { EventForm } from "../components/EventForm";
import { useAuth } from "../hooks/useAuth";
import { eventPath } from "../lib/urls";

export function EditEventPage({ id, username, slug }: { id?: string; username?: string; slug?: string }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const promise =
      username && slug
        ? eventsApi.getBySlug(username, slug)
        : id
          ? eventsApi.get(id)
          : Promise.reject(new Error("No event identifier"));

    promise
      .then(setEvent)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id, username, slug]);

  if (loading) return <p className="text-muted">Loading…</p>;
  if (!event) return <p className="error-text">Event not found.</p>;
  if (user?.id !== event.accountId) return <p className="error-text">Not authorized.</p>;

  const handleSubmit = async (data: EventInput) => {
    const updated = await eventsApi.update(event.id, data);
    navigate(eventPath(updated));
  };

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem" }}>Edit Event</h1>
      <EventForm
        initial={{
          title: event.title,
          description: event.description || undefined,
          startDate: event.startDate,
          endDate: event.endDate || undefined,
          allDay: event.allDay,
          location: event.location || undefined,
          image: event.image || undefined,
          url: event.url || undefined,
          tags: event.tags,
          visibility: event.visibility,
        }}
        onSubmit={handleSubmit}
        submitLabel="Save Changes"
      />
    </div>
  );
}
