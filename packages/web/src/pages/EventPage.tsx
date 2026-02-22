import { useEffect, useState, useMemo } from "react";
import { useLocation, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { eventsPathWithTags } from "../lib/urls";
import { events as eventsApi, users as usersApi, federation, type CalEvent } from "../lib/api";
import { sanitizeHtml } from "../lib/sanitize";
import { useAuth } from "../hooks/useAuth";
import { eventPath, accountProfilePath, profilePath, remoteProfilePath, decodeRemoteEventId } from "../lib/urls";
import { formatEventDateTime } from "../lib/formatEventDateTime";
import { LocationPinIcon, RepostIcon, ExternalLinkIcon } from "../components/icons";
import { ProfileCard, getProfileKey, type ProfileItem } from "../components/ProfileCard";
import { LocationMap } from "../components/LocationMap";
import { EventCard } from "../components/EventCard";
import { ImageAttributionBadge } from "../components/ImageAttributionBadge";

type RsvpStatus = "going" | "maybe" | null;

export function EventPage({ id, username, slug }: { id?: string; username?: string; slug?: string }) {
  const { t, i18n } = useTranslation(["events", "common"]);
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

  const rsvpOptions = useMemo(
    () => [
      { value: "going" as RsvpStatus, label: t("going"), icon: "✓" },
      { value: "maybe" as RsvpStatus, label: t("maybe"), icon: "?" },
    ],
    [t]
  );

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
      .catch((e) => {
        setEvent(null);
        const msg = e.message;
        if (msg === "Invalid event") setError(t("eventNotFound"));
        else if (msg === "No event identifier") setError(t("noEventIdentifier"));
        else setError(msg);
      })
      .finally(() => setLoading(false));
  }, [id, username, slug, user?.id, t]);

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
        const res = await federation.follow(profileItem.actor.uri);
        if (res.delivered) {
          setFollowedActorUris((prev) => new Set([...prev, profileItem.actor.uri]));
        }
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
    if (!event || !confirm(t("deleteEventConfirm"))) return;
    await eventsApi.delete(event.id);
    navigate("/");
  };

  if (loading) return <p className="text-muted">{t("common:loading")}</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!event) return <p className="error-text">{t("eventNotFound")}</p>;

  const isOwner = user?.id === event.accountId;
  const editHref = event.slug && event.account?.username
    ? `/@${event.account.username}/${event.slug}/edit`
    : `/events/${event.id}/edit`;

  const hasLocationCoords =
    event.location?.latitude != null && event.location?.longitude != null;

  const isCanceled = !!event.canceled;

  return (
    <div className="flex" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: "1.5rem" }}>
      {/* Main content */}
      <article style={{ flex: 1, minWidth: 0 }}>
      {isCanceled && (
        <div
          className="canceled-badge mb-2"
          style={{
            display: "inline-block",
            padding: "0.5rem 0.75rem",
            fontSize: "0.9rem",
          }}
        >
          {t("canceledByOrganizer")}
        </div>
      )}
      {event.image && (
        <div style={{ marginBottom: "1.5rem", position: "relative" }}>
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
          {event.image.attribution && (
            <ImageAttributionBadge attribution={event.image.attribution} />
          )}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <div className="flex flex-col gap-1">
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>
            {formatEventDateTime(event, true, { locale: i18n.language, allDayLabel: t("allDay") })}
          </span>
          {event.visibility !== "public" && (
            <span className={`visibility-badge ${event.visibility}`} style={{ alignSelf: "flex-start" }}>
              {event.visibility === "followers_only" ? t("followersOnly") : event.visibility === "private" ? t("onlyMe") : event.visibility === "unlisted" ? t("unlisted") : event.visibility}
            </span>
          )}
        </div>

        {isOwner && (
          <div className="flex gap-1">
            <Link href={editHref}>
              <button className="btn-ghost btn-sm">{t("common:edit")}</button>
            </Link>
            <button className="btn-danger btn-sm" onClick={handleDelete}>
              {t("common:delete")}
            </button>
          </div>
        )}
      </div>

      <h1
        style={{
          fontSize: "1.8rem",
          fontWeight: 700,
          lineHeight: 1.2,
          marginBottom: "0.5rem",
          ...(isCanceled && { textDecoration: "line-through", color: "var(--text-dim)" }),
        }}
      >
        {event.title}
      </h1>

      {event.account && (
        <p className="text-muted mb-2">
          {t("by")}{" "}
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

      {user && !isCanceled && (
        <div
          className="flex gap-1 mb-4"
          style={{ flexWrap: "wrap", alignItems: "center" }}
        >
          {rsvpOptions.map((opt) => (
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
                title={reposted ? t("removeRepost") : t("repostToFeed")}
              >
                <RepostIcon />
                {reposted ? t("reposted") : t("repost")}
              </button>
            </>
          )}
        </div>
      )}

      {event.description && (
        <div
          className="event-description"
          dangerouslySetInnerHTML={{
            __html: sanitizeHtml(event.description.replace(/\n/g, "<br>")),
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
            {event.source === "remote" ? t("viewOnOriginalSite") : event.url}
          </a>
        </p>
      )}

      {event.tags.length > 0 && (
        <div className="flex gap-1 mt-2" style={{ flexWrap: "wrap" }}>
          {event.tags.map((t) => (
            <Link
              key={t}
              href={eventsPathWithTags([t])}
              className="tag tag-clickable"
            >
              {t}
            </Link>
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
              {t("host")}
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
              {t("location")}
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
              {t("moreFromHost")}
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
              {t("host")}
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
              {t("location")}
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
              {t("moreFromHost")}
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
