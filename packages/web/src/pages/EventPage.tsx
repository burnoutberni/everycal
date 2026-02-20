import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import DOMPurify from "dompurify";
import { events as eventsApi, users as usersApi, federation, type CalEvent } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { eventPath, accountProfilePath, profilePath, remoteProfilePath, decodeRemoteEventId } from "../lib/urls";
import { formatEventDateTime } from "../lib/formatEventDateTime";
import { LocationPinIcon, RepostIcon, ExternalLinkIcon } from "../components/icons";
import { ProfileCard, getProfileKey, type ProfileItem } from "../components/ProfileCard";
import { LocationMap } from "../components/LocationMap";
import { EventCard } from "../components/EventCard";

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
  const [profileItem, setProfileItem] = useState<ProfileItem | null>(null);
  const [suggestedEvents, setSuggestedEvents] = useState<CalEvent[]>([]);
  const [followedLocalIds, setFollowedLocalIds] = useState<Set<string>>(new Set());
  const [followedActorUris, setFollowedActorUris] = useState<Set<string>>(new Set());
  const [followBusy, setFollowBusy] = useState<string | null>(null);

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

  // Fetch host profile and suggested events when event is loaded
  useEffect(() => {
    if (!event?.account) {
      setProfileItem(null);
      setSuggestedEvents([]);
      return;
    }

    const account = event.account;
    const isLocal = event.source === "local";

    // Build ProfileItem: fetch User for local, build minimal RemoteActor for remote
    if (isLocal) {
      const localUsername = account.username;
      usersApi
        .get(localUsername)
        .then((u) => setProfileItem({ kind: "local", user: u }))
        .catch(() => setProfileItem(null));
    } else {
      const atIdx = account.username.indexOf("@");
      const usernamePart = atIdx >= 0 ? account.username.slice(0, atIdx) : account.username;
      const domainPart = account.domain || (atIdx >= 0 ? account.username.slice(atIdx + 1) : "");
      const actor: ProfileItem = {
        kind: "remote",
        actor: {
          uri: event.actorUri || `https://${domainPart}/users/${usernamePart}`,
          type: "Person",
          username: usernamePart,
          displayName: account.displayName || usernamePart,
          summary: null,
          domain: domainPart,
          iconUrl: account.iconUrl ?? null,
          imageUrl: null,
        },
      };
      setProfileItem(actor);
    }

    // Fetch suggested events (other events from same host only, excluding current)
    if (isLocal) {
      const localUsername = account.username;
      usersApi
        .events(localUsername, { limit: 6 })
        .then((res) =>
          setSuggestedEvents(
            res.events
              .filter((e) => e.id !== event.id && e.accountId === event.accountId)
              .slice(0, 5)
          )
        )
        .catch(() => setSuggestedEvents([]));
    } else if (event.actorUri) {
      federation
        .remoteEvents({ actor: event.actorUri, limit: 6 })
        .then((res) =>
          setSuggestedEvents(
            res.events
              .filter((e) => e.id !== event.id && e.actorUri === event.actorUri)
              .slice(0, 5)
          )
        )
        .catch(() => setSuggestedEvents([]));
    } else {
      setSuggestedEvents([]);
    }
  }, [event]);

  // Fetch follow state when user is logged in
  useEffect(() => {
    if (!user || !profileItem) return;
    if (profileItem.kind === "local") {
      usersApi
        .following(user.username)
        .then((res) => setFollowedLocalIds(new Set(res.users.map((u) => u.id))))
        .catch(() => {});
    } else {
      federation
        .followedActors()
        .then((res) => setFollowedActorUris(new Set(res.actors.map((a) => a.uri))))
        .catch(() => {});
    }
  }, [user, profileItem]);

  const isHostFollowed = profileItem
    ? profileItem.kind === "local"
      ? followedLocalIds.has(profileItem.user.id)
      : followedActorUris.has(profileItem.actor.uri)
    : false;
  const isHostOwn = profileItem?.kind === "local" && user && profileItem.user.id === user.id;

  const handleFollowHost = async () => {
    if (!user || !profileItem) return;
    setFollowBusy(getProfileKey(profileItem));
    try {
      if (profileItem.kind === "local") {
        await usersApi.follow(profileItem.user.username);
        setFollowedLocalIds((prev) => new Set([...prev, profileItem.user.id]));
      } else {
        await federation.follow(profileItem.actor.uri);
        setFollowedActorUris((prev) => new Set([...prev, profileItem.actor.uri]));
      }
    } catch {
      // ignore
    } finally {
      setFollowBusy(null);
    }
  };

  const handleUnfollowHost = async () => {
    if (!user || !profileItem) return;
    setFollowBusy(getProfileKey(profileItem));
    try {
      if (profileItem.kind === "local") {
        await usersApi.unfollow(profileItem.user.username);
        setFollowedLocalIds((prev) => {
          const next = new Set(prev);
          if (profileItem?.kind === "local") next.delete(profileItem.user.id);
          return next;
        });
      } else {
        await federation.unfollow(profileItem.actor.uri);
        setFollowedActorUris((prev) => {
          const next = new Set(prev);
          if (profileItem?.kind === "remote") next.delete(profileItem.actor.uri);
          return next;
        });
      }
    } catch {
      // ignore
    } finally {
      setFollowBusy(null);
    }
  };

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

  const hasLocationCoords =
    event.location?.latitude != null && event.location?.longitude != null;

  return (
    <div className="flex" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: "1.5rem" }}>
      {/* Main content */}
      <article style={{ flex: 1, minWidth: 0 }}>
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
          <Link href={accountProfilePath(event.account, event.source)}>
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
        <p className="mt-2" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <a
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          >
            <ExternalLinkIcon />
            {event.source === "remote" ? "View on original site" : event.url}
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

      {/* Sidebar */}
      <aside
        className="hide-mobile"
        style={{
          flex: "0 1 280px",
          minWidth: 200,
          maxWidth: 280,
          position: "sticky",
          top: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        {profileItem && (
          <div className="card">
            <div className="text-sm text-dim" style={{ marginBottom: "0.5rem", fontWeight: 600 }}>
              Host
            </div>
            <ProfileCard
              item={profileItem}
              isFollowed={!!isHostFollowed}
              isOwn={!!isHostOwn}
              onFollow={handleFollowHost}
              onUnfollow={handleUnfollowHost}
              busy={followBusy === getProfileKey(profileItem)}
              canFollow={!!user}
              profilePath={profilePath}
              remoteProfilePath={remoteProfilePath}
            />
          </div>
        )}

        {(hasLocationCoords || event.location?.name) && event.location && (
          <div className="card">
            <div className="text-sm text-dim" style={{ marginBottom: "0.5rem", fontWeight: 600 }}>
              Location
            </div>
            <LocationMap
              location={event.location}
              latitude={event.location.latitude ?? undefined}
              longitude={event.location.longitude ?? undefined}
            />
          </div>
        )}

        {suggestedEvents.length > 0 && (
          <div>
            <div className="text-sm text-dim" style={{ marginBottom: "0.5rem", fontWeight: 600 }}>
              More from this host
            </div>
            <div className="flex flex-col gap-1">
              {suggestedEvents.map((ev) => (
                <EventCard key={ev.id} event={ev} compact />
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* Mobile: sidebar content below main */}
      <div className="show-mobile" style={{ flex: "1 1 100%", marginTop: "1.5rem" }}>
        {profileItem && (
          <div className="card mb-3">
            <div className="text-sm text-dim" style={{ marginBottom: "0.5rem", fontWeight: 600 }}>
              Host
            </div>
            <ProfileCard
              item={profileItem}
              isFollowed={!!isHostFollowed}
              isOwn={!!isHostOwn}
              onFollow={handleFollowHost}
              onUnfollow={handleUnfollowHost}
              busy={followBusy === getProfileKey(profileItem)}
              canFollow={!!user}
              profilePath={profilePath}
              remoteProfilePath={remoteProfilePath}
            />
          </div>
        )}
        {(hasLocationCoords || event.location?.name) && event.location && (
          <div className="card mb-3">
            <div className="text-sm text-dim" style={{ marginBottom: "0.5rem", fontWeight: 600 }}>
              Location
            </div>
            <LocationMap
              location={event.location}
              latitude={event.location.latitude ?? undefined}
              longitude={event.location.longitude ?? undefined}
            />
          </div>
        )}
        {suggestedEvents.length > 0 && (
          <div>
            <div className="text-sm text-dim" style={{ marginBottom: "0.5rem", fontWeight: 600 }}>
              More from this host
            </div>
            <div className="flex flex-col gap-1">
              {suggestedEvents.map((ev) => (
                <EventCard key={ev.id} event={ev} compact />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
