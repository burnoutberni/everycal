import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import DOMPurify from "dompurify";
import { events as eventsApi, type CalEvent } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { eventPath, profilePath, decodeRemoteEventId } from "../lib/urls";
import { formatEventDateTime } from "../lib/formatEventDateTime";
import { LocationPinIcon, RepostIcon } from "../components/icons";

type RsvpStatus = "going" | "maybe" | null;

const RSVP_OPTIONS: { value: RsvpStatus; label: string; icon: string }[] = [
  { value: "going", label: "Going", icon: "✓" },
  { value: "maybe", label: "Maybe", icon: "?" },
];

export function EventPage({ id, username, slug }: { id?: string; username?: string; slug?: string }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rsvp, setRsvp] = useState<RsvpStatus>(null);
  const [reposted, setReposted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [repostSaving, setRepostSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError("");

    let promise: Promise<CalEvent>;
    if (username && slug) {
      if (username.includes("@")) {
        try {
          const eventUri = decodeRemoteEventId(slug);
          promise = eventsApi.get(eventUri);
        } catch {
          promise = Promise.reject(new Error("Invalid event"));
        }
      } else {
        promise = eventsApi.getBySlug(username, slug);
      }
    } else if (id) {
      promise = eventsApi.get(id);
    } else {
      promise = Promise.reject(new Error("No event identifier"));
    }

    promise
      .then((ev) => {
        setEvent(ev);
        setRsvp((ev.rsvpStatus ?? null) as RsvpStatus);
        setReposted(ev.reposted ?? false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, username, slug]);

  const handleRsvp = async (status: RsvpStatus) => {
    if (!event || !user || saving) return;
    const newStatus = status === rsvp ? null : status;
    setSaving(true);
    try {
      await eventsApi.rsvp(event.id, newStatus);
      setRsvp(newStatus);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleRepost = async () => {
    if (!event || !user || repostSaving || event.source === "remote") return;
    if (event.accountId === user.id) return;
    setRepostSaving(true);
    try {
      if (reposted) {
        await eventsApi.unrepost(event.id);
        setReposted(false);
      } else {
        await eventsApi.repost(event.id);
        setReposted(true);
      }
    } catch {
      // ignore
    } finally {
      setRepostSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!event || !confirm("Delete this event?")) return;
    await eventsApi.delete(event.id);
    navigate("/");
  };

  if (loading) return <p className="text-muted">Loading…</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!event) return <p className="error-text">Event not found.</p>;

  const isOwner = user?.id === event.accountId;
  const editHref = event.slug && event.account?.username
    ? `/@${event.account.username}/${event.slug}/edit`
    : `/events/${event.id}/edit`;

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
        <div className="flex flex-col gap-1">
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>
            {formatEventDateTime(event, true)}
          </span>
          {event.visibility !== "public" && (
            <span className={`visibility-badge ${event.visibility}`} style={{ alignSelf: "flex-start" }}>
              {event.visibility}
            </span>
          )}
        </div>

        {isOwner && (
          <div className="flex gap-1">
            <Link href={editHref}>
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
          <Link href={profilePath(event.account.username, event.account.domain)}>
            {event.account.displayName || event.account.username}
          </Link>
          {event.source === "remote" && event.account.domain && (
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

      {event.location && (
        <p className="mb-2" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <LocationPinIcon />
          {event.location.name}
          {event.location.address && ` — ${event.location.address}`}
        </p>
      )}

      {user && (
        <div
          className="flex gap-1 mb-4"
          style={{ flexWrap: "wrap", alignItems: "center" }}
        >
          {RSVP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleRsvp(opt.value)}
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

      {event.description && (
        <div
          className="event-description"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(event.description.replace(/\n/g, "<br>"), {
              ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "br", "p", "span"],
              ALLOWED_ATTR: ["href", "rel", "target"],
            }),
          }}
        />
      )}

      {event.url && (
        <p className="mt-2">
          <a href={event.url} target="_blank" rel="noopener noreferrer">
            🔗 {event.source === "remote" ? "View on original site" : event.url}
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
