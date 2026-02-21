import { useState } from "react";
import { Link } from "wouter";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { eventPath, accountProfilePath, profilePath, eventsPathWithTags } from "../lib/urls";
import { formatEventDateTime } from "../lib/formatEventDateTime";
import { LocationPinIcon, RepostIcon } from "./icons";

type RsvpStatus = "going" | "maybe" | null;

const RSVP_OPTIONS: { value: RsvpStatus; label: string; icon: string }[] = [
  { value: "going", label: "Going", icon: "✓" },
  { value: "maybe", label: "Maybe", icon: "?" },
];

export function EventCard({
  event,
  onRsvpChange,
  onRepostChange,
  compact,
  selectedTags,
}: {
  event: CalEvent;
  onRsvpChange?: (eventId: string, status: RsvpStatus) => void;
  onRepostChange?: (eventId: string, reposted: boolean) => void;
  /** When true and event has image: image on top full-width, content below. For narrow sidebars. */
  compact?: boolean;
  /** Tags currently used as filter; matching tags will be highlighted */
  selectedTags?: string[];
}) {
  const { user } = useAuth();
  const [rsvp, setRsvp] = useState<RsvpStatus>(event.rsvpStatus ?? null);
  const [reposted, setReposted] = useState(event.reposted ?? false);
  const [saving, setSaving] = useState(false);
  const [repostSaving, setRepostSaving] = useState(false);

  const dateTimeStr = formatEventDateTime(event);
  const isRemote = event.source === "remote";
  const isCanceled = !!event.canceled;

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
    <article
      className={`card ${isCanceled ? "event-canceled" : ""}`}
      style={{
        position: "relative",
        cursor: "pointer",
        transition: "border-color 0.15s",
        ...(isCanceled && { opacity: 0.85 }),
      }}
    >
      <Link
        href={eventPath(event)}
        className="card-link-overlay"
        aria-label={`View event: ${event.title}`}
      />
      {event.repostedBy && (
        <p
          className="card-actions text-dim"
          style={{
            fontSize: "0.7rem",
            opacity: 0.75,
            marginBottom: "0.35rem",
            display: "flex",
            alignItems: "center",
            gap: "0.3rem",
          }}
        >
          <RepostIcon />
          reposted by{" "}
          <Link href={profilePath(event.repostedBy.username)}>
            {event.repostedBy.displayName || `@${event.repostedBy.username}`}
          </Link>
        </p>
      )}
      <div className={compact && event.image ? "" : "flex gap-1.5"}>
        {event.image && (
          <div
            style={
              compact
                ? {
                    width: "100%",
                    marginBottom: "0.5rem",
                    borderRadius: "var(--radius-sm)",
                    overflow: "hidden",
                  }
                : { flex: "0 0 120px" }
            }
          >
            <img
              src={event.image.url}
              alt={event.image.alt || event.title}
              style={{
                width: "100%",
                height: compact ? "100px" : "80px",
                objectFit: "cover",
                borderRadius: "var(--radius-sm)",
              }}
            />
          </div>
        )}
        <div className={compact && event.image ? "" : "flex-1"} style={{ minWidth: 0 }}>
          <div className="flex items-center gap-1 mb-1" style={{ flexWrap: "wrap" }}>
            <span className="text-sm" style={{ color: "var(--accent)" }}>
              {dateTimeStr}
            </span>
            {isCanceled && (
              <span className="canceled-badge" style={{ fontSize: "0.7rem", fontWeight: 600 }}>
                Canceled
              </span>
            )}
          </div>
          {event.visibility !== "public" && !isCanceled && (
            <div className="flex items-center gap-1 mb-1">
              <span className={`visibility-badge ${event.visibility}`}>
                {event.visibility === "followers_only" ? "followers only" : event.visibility === "private" ? "Only me" : event.visibility}
              </span>
            </div>
          )}

          <h3
            style={{
              fontSize: "1.05rem",
              fontWeight: 600,
              lineHeight: 1.3,
              ...(isCanceled && { textDecoration: "line-through", color: "var(--text-dim)" }),
            }}
          >
            {event.title}
          </h3>

          {event.location && (
            <p className="text-sm text-muted mt-1" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
              <LocationPinIcon />
              {event.location.name}
            </p>
          )}

          {event.account && (
            <p className="card-actions text-sm text-dim mt-1">
              by{" "}
              <Link href={accountProfilePath(event.account, event.source)}>
                {event.account.displayName || event.account.username}
              </Link>
              {isRemote && event.account.domain && (
                <>
                  {" · "}
                  <a
                    href={`https://${event.account.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ opacity: 0.8 }}
                  >
                    {event.account.domain}
                  </a>
                </>
              )}
            </p>
          )}

          {event.tags.length > 0 && (
            <div className="card-actions flex gap-1 mt-1" style={{ flexWrap: "wrap" }}>
              {event.tags.slice(0, 4).map((t) => (
                <Link
                  key={t}
                  href={eventsPathWithTags([t])}
                  className={`tag tag-clickable ${selectedTags?.includes(t) ? "tag-selected" : ""}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {t}
                </Link>
              ))}
            </div>
          )}

          {/* RSVP & Repost buttons (disabled when canceled) */}
          {user && !isCanceled && (
            <div className="card-actions flex gap-1 mt-1" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {RSVP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={(e) => handleRsvp(opt.value, e)}
                  disabled={saving}
                  className={`rsvp-btn ${rsvp === opt.value ? `rsvp-active rsvp-${opt.value}` : ""}`}
                  title={opt.label}
                >
                  {opt.icon} {opt.label}
                </button>
              ))}
              {event.source !== "remote" && event.accountId !== user.id && (
                <>
                  <span
                    style={{
                      width: 1,
                      height: "1rem",
                      background: "var(--border)",
                      margin: "0 0.15rem",
                    }}
                  />
                  <button
                    onClick={handleRepost}
                    disabled={repostSaving}
                    className={reposted ? "rsvp-btn rsvp-active rsvp-maybe" : "rsvp-btn"}
                    title={reposted ? "Remove repost" : "Repost to your feed"}
                  >
                    <RepostIcon />
                    {reposted ? "Reposted" : "Repost"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );

  return cardContent;
}
