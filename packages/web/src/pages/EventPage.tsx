import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { Link } from "wouter";

export function EventPage({ params }: { params?: { id: string } }) {
  // wouter passes params via route
  const id = params?.id || window.location.pathname.split("/events/")[1]?.split("/")[0];
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    eventsApi
      .get(id)
      .then(setEvent)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!event || !confirm("Delete this event?")) return;
    await eventsApi.delete(event.id);
    navigate("/");
  };

  if (loading) return <p className="text-muted">Loading…</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!event) return <p className="error-text">Event not found.</p>;

  const isOwner = user?.id === event.accountId;
  const date = new Date(event.startDate);

  return (
    <article>
      {event.image && (
        <div style={{ marginBottom: "1.5rem" }}>
          <img
            src={event.image.url}
            alt={event.image.alt || event.title}
            style={{
              width: "100%",
              maxHeight: "350px",
              objectFit: "cover",
              borderRadius: "var(--radius)",
            }}
          />
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>
            {date.toLocaleDateString(undefined, {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </span>
          {!event.allDay && (
            <span className="text-muted">
              · {date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              {event.endDate && (
                <>
                  {" – "}
                  {new Date(event.endDate).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </>
              )}
            </span>
          )}
          <span className={`visibility-badge ${event.visibility}`}>{event.visibility}</span>
        </div>

        {isOwner && (
          <div className="flex gap-1">
            <Link href={`/events/${event.id}/edit`}>
              <button className="btn-ghost btn-sm">Edit</button>
            </Link>
            <button className="btn-danger btn-sm" onClick={handleDelete}>
              Delete
            </button>
          </div>
        )}
      </div>

      <h1 style={{ fontSize: "1.8rem", fontWeight: 700, lineHeight: 1.2, marginBottom: "0.5rem" }}>
        {event.title}
      </h1>

      {event.account && (
        <p className="text-muted mb-2">
          by{" "}
          <Link href={`/users/${event.account.username}`}>
            {event.account.displayName || event.account.username}
          </Link>
        </p>
      )}

      {event.location && (
        <p className="mb-2">📍 {event.location.name}{event.location.address && ` — ${event.location.address}`}</p>
      )}

      {event.description && (
        <div
          className="mt-2"
          style={{
            whiteSpace: "pre-wrap",
            lineHeight: 1.7,
            color: "var(--text)",
          }}
        >
          {event.description}
        </div>
      )}

      {event.url && (
        <p className="mt-2">
          <a href={event.url} target="_blank" rel="noopener noreferrer">
            🔗 {event.url}
          </a>
        </p>
      )}

      {event.tags.length > 0 && (
        <div className="flex gap-1 mt-2" style={{ flexWrap: "wrap" }}>
          {event.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
