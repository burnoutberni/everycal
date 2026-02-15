import { useLocation } from "wouter";
import { events as eventsApi, type EventInput } from "../lib/api";
import { EventForm } from "../components/EventForm";
import { useAuth } from "../hooks/useAuth";
import { Link } from "wouter";
import { eventPath } from "../lib/urls";

export function NewEventPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  if (!user) {
    return (
      <div className="empty-state mt-3">
        <p>
          <Link href="/login">Log in</Link> to create events.
        </p>
      </div>
    );
  }

  const handleSubmit = async (data: EventInput) => {
    const event = await eventsApi.create(data);
    navigate(eventPath(event));
  };

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "1.5rem" }}>Create Event</h1>
      <EventForm onSubmit={handleSubmit} submitLabel="Create Event" />
    </div>
  );
}
