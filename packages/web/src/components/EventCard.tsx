import { Link } from "wouter";
import type { CalEvent } from "../lib/api";

export function EventCard({ event }: { event: CalEvent }) {
  const date = new Date(event.startDate);
  const dateStr = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = event.allDay
    ? "All day"
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <Link href={`/events/${event.id}`}>
      <article className="card" style={{ cursor: "pointer", transition: "border-color 0.15s" }}>
        <div className="flex gap-2">
          {event.image && (
            <div style={{ flex: "0 0 120px" }}>
              <img
                src={event.image.url}
                alt={event.image.alt || event.title}
                style={{
                  width: "100%",
                  height: "80px",
                  objectFit: "cover",
                  borderRadius: "var(--radius-sm)",
                }}
              />
            </div>
          )}
          <div className="flex-1" style={{ minWidth: 0 }}>
            <div className="flex items-center gap-1 mb-1">
              <span className="text-sm" style={{ color: "var(--accent)" }}>
                {dateStr} · {timeStr}
              </span>
              {event.visibility !== "public" && (
                <span className={`visibility-badge ${event.visibility}`}>{event.visibility}</span>
              )}
            </div>

            <h3 style={{ fontSize: "1.05rem", fontWeight: 600, lineHeight: 1.3 }}>{event.title}</h3>

            {event.location && (
              <p className="text-sm text-muted mt-1">📍 {event.location.name}</p>
            )}

            {event.account && (
              <p className="text-sm text-dim mt-1">
                by {event.account.displayName || event.account.username}
              </p>
            )}

            {event.tags.length > 0 && (
              <div className="flex gap-1 mt-1" style={{ flexWrap: "wrap" }}>
                {event.tags.slice(0, 4).map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </article>
    </Link>
  );
}
