import { useState } from "react";
import { Link } from "wouter";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { eventPath } from "../lib/urls";

type RsvpStatus = "going" | "maybe" | null;

const RSVP_OPTIONS: { value: RsvpStatus; label: string; icon: string }[] = [
  { value: "going", label: "Going", icon: "✓" },
  { value: "maybe", label: "Maybe", icon: "?" },
];

export function EventCard({
  event,
  onRsvpChange,
  onRepostChange,
}: {
  event: CalEvent;
  onRsvpChange?: (eventId: string, status: RsvpStatus) => void;
  onRepostChange?: (eventId: string, reposted: boolean) => void;
}) {
  const { user } = useAuth();
  const [rsvp, setRsvp] = useState<RsvpStatus>(event.rsvpStatus ?? null);
  const [reposted, setReposted] = useState(event.reposted ?? false);
  const [saving, setSaving] = useState(false);
  const [repostSaving, setRepostSaving] = useState(false);

  const date = new Date(event.startDate);
  const isCurrentYear = date.getFullYear() === new Date().getFullYear();
  const dateStr = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(isCurrentYear ? {} : { year: "numeric" }),
  });
  const timeStr = event.allDay
    ? "All day"
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  const isRemote = event.source === "remote";

  const handleRsvp = async (status: RsvpStatus, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user || saving) return;

    const newStatus = status === rsvp ? null : status; // toggle off if same
    setSaving(true);
    try {
      await eventsApi.rsvp(event.id, newStatus);
      setRsvp(newStatus);
      onRsvpChange?.(event.id, newStatus);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleRepost = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user || repostSaving || event.source === "remote") return;
    // Don't allow reposting own events
    if (event.accountId === user.id) return;

    setRepostSaving(true);
    try {
      if (reposted) {
        await eventsApi.unrepost(event.id);
        setReposted(false);
        onRepostChange?.(event.id, false);
      } else {
        await eventsApi.repost(event.id);
        setReposted(true);
        onRepostChange?.(event.id, true);
      }
    } catch {
      // ignore
    } finally {
      setRepostSaving(false);
    }
  };

  const cardContent = (
    <article className="card" style={{ cursor: "pointer", transition: "border-color 0.15s" }}>
      {event.repostedBy && (
        <p className="text-sm text-dim" style={{ marginBottom: "0.5rem" }}>
          🔁 reposted by {event.repostedBy.displayName || `@${event.repostedBy.username}`}
        </p>
      )}
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
            {isRemote && event.account?.domain && (
              <span className="tag" style={{ fontSize: "0.7rem", opacity: 0.7 }}>
                {event.account.domain}
              </span>
            )}
            {rsvp && (
              <span
                className="tag"
                style={{
                  fontSize: "0.7rem",
                  background: rsvp === "going" ? "var(--success)" : "var(--accent)",
                  color: "#000",
                  borderColor: "transparent",
                }}
              >
                {rsvp === "going" ? "✓ Going" : "? Maybe"}
              </span>
            )}
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

          {/* RSVP & Repost buttons */}
          {user && (
            <div
              className="flex gap-1 mt-1"
              style={{ flexWrap: "wrap" }}
              onClick={(e) => e.preventDefault()}
            >
              {event.source !== "remote" && event.accountId !== user.id && (
                <button
                  onClick={handleRepost}
                  disabled={repostSaving}
                  className={reposted ? "rsvp-btn rsvp-active" : "rsvp-btn"}
                  title={reposted ? "Remove repost" : "Repost to your feed"}
                  style={reposted ? { background: "var(--accent)", color: "#000", borderColor: "transparent" } : undefined}
                >
                  🔁 {reposted ? "Reposted" : "Repost"}
                </button>
              )}
              {RSVP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={(e) => handleRsvp(opt.value, e)}
                  disabled={saving}
                  className={rsvp === opt.value ? "rsvp-btn rsvp-active" : "rsvp-btn"}
                  title={opt.label}
                >
                  {opt.icon} {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );

  return <Link href={eventPath(event)}>{cardContent}</Link>;
}
