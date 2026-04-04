import { useEffect, useState, useMemo, useRef, useId } from "react";
import { useLocation, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { eventsPathWithTags } from "../lib/urls";
import { events as eventsApi, users as usersApi, federation, identities as identitiesApi, type CalEvent } from "../lib/api";
import { sanitizeHtmlWithNewlines } from "../lib/sanitize";
import { useAuth } from "../hooks/useAuth";
import { useHasAdditionalIdentities } from "../hooks/useHasAdditionalIdentities";
import { accountProfilePath, profilePath, remoteProfilePath } from "../lib/urls";
import { formatEventDateTime, hasDifferentTimezoneAtEventTime } from "../lib/formatEventDateTime";
import { resolveDateTimeLocale, resolveUserTimezone } from "../lib/dateTimeLocale";
import { normalizeEmbeddableEverycalPath } from "../lib/everycalEmbed";
import { LocationPinIcon, RepostIcon, ExternalLinkIcon, MenuIcon } from "../components/icons";
import { ProfileCard, getProfileKey, type ProfileItem } from "../components/ProfileCard";
import { LocationMap } from "../components/LocationMap";
import { EventCard } from "../components/EventCard";
import { ImageAttributionBadge } from "../components/ImageAttributionBadge";
import { ActAsActionModal } from "../components/ActAsActionModal";
import { EmbedCodeModal } from "../components/EmbedCodeModal";
import { useOptionalPageContext } from "../renderer/PageContext";

type RsvpStatus = "going" | "maybe" | null;

export function EventPage({ id, username, slug }: { id?: string; username?: string; slug?: string }) {
  const { t, i18n } = useTranslation(["events", "common"]);
  const { user } = useAuth();
  const dateTimeLocale = resolveDateTimeLocale(user, i18n.language);
  const { hasAdditionalIdentities, loading: identitiesLoading } = useHasAdditionalIdentities();
  const [location, navigate] = useLocation();

  const routeMatch = useMemo((): { id?: string; username?: string; slug?: string } => {
    const eventBySlugMatch = location.match(/^\/@([^/]+)\/([^/]+)\/?$/);
    if (eventBySlugMatch) {
      return {
        username: decodeURIComponent(eventBySlugMatch[1]),
        slug: decodeURIComponent(eventBySlugMatch[2]),
      };
    }

    const legacyMatch = location.match(/^\/events\/([^/]+)\/?$/);
    if (legacyMatch) {
      return {
        id: decodeURIComponent(legacyMatch[1]),
      };
    }

    return {};
  }, [location]);

  const effectiveId = id ?? routeMatch.id;
  const effectiveUsername = username ?? routeMatch.username;
  const effectiveSlug = slug ?? routeMatch.slug;

  // SSR initial state detection
  const pageContext = useOptionalPageContext();
  const initialEvent = useMemo(() => {
    const ev = (pageContext?.data as any)?.event;
    if (!ev) return null;
    if (effectiveId === undefined && effectiveUsername === ev.account?.username && effectiveSlug === ev.slug) {
      return ev as CalEvent;
    }
    return null;
  }, [pageContext, effectiveId, effectiveUsername, effectiveSlug]);

  const [event, setEvent] = useState<CalEvent | null>(initialEvent);
  const [loading, setLoading] = useState(initialEvent === null);
  const [error, setError] = useState("");
  const [rsvp, setRsvp] = useState<RsvpStatus>(initialEvent ? ((initialEvent.rsvpStatus ?? null) as RsvpStatus) : null);
  const [reposted, setReposted] = useState(initialEvent ? (initialEvent.reposted ?? false) : false);
  const [saving, setSaving] = useState(false);
  const [repostSaving, setRepostSaving] = useState(false);
  const [eventActionMenuOpen, setEventActionMenuOpen] = useState(false);
  const [repostAsOpen, setRepostAsOpen] = useState(false);
  const [embedModalOpen, setEmbedModalOpen] = useState(false);
  const [repostAsError, setRepostAsError] = useState<string | null>(null);
  const [profileItem, setProfileItem] = useState<ProfileItem | null>(null);
  const [suggestedEvents, setSuggestedEvents] = useState<CalEvent[]>([]);
  const [followedLocalIds, setFollowedLocalIds] = useState<Set<string>>(new Set());
  const [followedActorUris, setFollowedActorUris] = useState<Set<string>>(new Set());
  const [followBusy, setFollowBusy] = useState<string | null>(null);
  const [canManageEvent, setCanManageEvent] = useState(false);
  const eventMenuRef = useRef<HTMLDivElement>(null);
  const eventMenuButtonRef = useRef<HTMLButtonElement>(null);
  const eventMenuId = useId();
  const viewerTimezoneTooltipId = useId();
  const viewerTimeZone = resolveUserTimezone(user);

  useEffect(() => {
    if (!eventActionMenuOpen) return;
    const handleEventMenuClickOutside = (e: MouseEvent) => {
      if (eventMenuRef.current && !eventMenuRef.current.contains(e.target as Node)) {
        setEventActionMenuOpen(false);
      }
    };
    const handleEventMenuEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setEventActionMenuOpen(false);
      eventMenuButtonRef.current?.focus();
    };
    document.addEventListener("click", handleEventMenuClickOutside);
    document.addEventListener("keydown", handleEventMenuEscape);
    return () => {
      document.removeEventListener("click", handleEventMenuClickOutside);
      document.removeEventListener("keydown", handleEventMenuEscape);
    };
  }, [eventActionMenuOpen]);

  const rsvpOptions = useMemo(
    () => [
      { value: "going" as RsvpStatus, label: t("going"), icon: "✓" },
      { value: "maybe" as RsvpStatus, label: t("maybe"), icon: "?" },
    ],
    [t]
  );

  useEffect(() => {
    if (event && (event.id === effectiveId || (event.slug === effectiveSlug && event.account?.username === effectiveUsername))) return; // Already SSR'd or fetched
    setLoading(true);
    setError("");

    let promise: Promise<CalEvent>;
    if (effectiveUsername && effectiveSlug) {
      promise = eventsApi.getBySlug(effectiveUsername, effectiveSlug);
    } else if (effectiveId) {
      promise = eventsApi.get(effectiveId);
    } else {
      promise = Promise.reject(new Error("No event identifier"));
    }

    const withTimeout = Promise.race<CalEvent>([
      promise,
      new Promise<CalEvent>((_, reject) =>
        setTimeout(() => reject(new Error("Event request timed out")), 10000)
      ),
    ]);

    withTimeout
      .then((ev) => {
        setEvent(ev);
        setRsvp((ev.rsvpStatus ?? null) as RsvpStatus);
        setReposted(ev.reposted ?? false);
      })
      .catch((e) => {
        setEvent(null);
        const msg = e.message;
        if (msg === "No event identifier") setError(t("noEventIdentifier"));
        else if (msg === "Event request timed out") setError(t("common:requestFailed"));
        else setError(msg);
      })
      .finally(() => setLoading(false));
  }, [effectiveId, effectiveUsername, effectiveSlug, user?.id, t]);

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
        .catch(() => { });
    } else {
      federation
        .followedActors()
        .then((res) => setFollowedActorUris(new Set(res.actors.map((a) => a.uri))))
        .catch(() => { });
    }
  }, [user, profileItem]);

  useEffect(() => {
    if (!event || !user || event.source === "remote") {
      setCanManageEvent(false);
      return;
    }
    if (event.accountId === user.id) {
      setCanManageEvent(true);
      return;
    }
    identitiesApi
      .list()
      .then((res) => setCanManageEvent(res.identities.some((identity) => identity.id === event.accountId)))
      .catch(() => setCanManageEvent(false));
  }, [event, user]);

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

  // Update meta tags for social sharing
  useEffect(() => {
    if (!event) return;

    const baseUrl = window.location.origin;
    const ogImageUrl = event.ogImageUrl || event.image?.url
      ? `${baseUrl}${event.ogImageUrl || event.image?.url}`
      : undefined;

    const title = event.title;
    const dateTimeDescription = formatEventDateTime(event, true, {
      locale: dateTimeLocale,
      allDayLabel: t("allDay"),
      viewerTimeZone,
      displayTimeZone: viewerTimeZone,
    });
    const description = dateTimeDescription
      ? (event.location?.name ? `${dateTimeDescription} • ${event.location.name}` : dateTimeDescription)
      : (event.location?.name || "");

    document.title = title;
    document.querySelector('meta[property="og:title"]')?.setAttribute("content", title);
    document.querySelector('meta[property="og:description"]')?.setAttribute("content", description);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute("content", title);
    document.querySelector('meta[name="twitter:description"]')?.setAttribute("content", description);
    if (ogImageUrl) {
      document.querySelector('meta[property="og:image"]')?.setAttribute("content", ogImageUrl);
      document.querySelector('meta[name="twitter:image"]')?.setAttribute("content", ogImageUrl);
    }
  }, [dateTimeLocale, event, t, user?.dateTimeLocale, viewerTimeZone]);

  const handleDelete = async () => {
    if (!event || !confirm(t("deleteEventConfirm"))) return;
    await eventsApi.delete(event.id);
    navigate("/");
  };

  if (loading) return <p className="text-muted">{t("common:loading")}</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!event) return <p className="error-text">{t("eventNotFound")}</p>;

  const editHref = event.slug && event.account?.username
    ? `/@${event.account.username}/${event.slug}/edit`
    : `/events/${event.id}/edit`;

  const hasLocationCoords =
    event.location?.latitude != null && event.location?.longitude != null;

  const isCanceled = !!event.canceled;
  const eventDateLabel = formatEventDateTime(event, true, {
    locale: dateTimeLocale,
    allDayLabel: t("allDay"),
    viewerTimeZone,
    displayTimeZone: viewerTimeZone,
  });
  const showViewerTimezoneTooltip = hasDifferentTimezoneAtEventTime(event, viewerTimeZone);
  const viewerTimezoneDateLabel = showViewerTimezoneTooltip
    ? (() => {
      const eventTz = event.eventTimezone;
      if (!eventTz) return "";
      const localDateTime = formatEventDateTime(event, true, {
        locale: dateTimeLocale,
        allDayLabel: t("allDay"),
        viewerTimeZone,
        displayTimeZone: eventTz,
      });
      return `${t("common:localTimeLabel")}: ${localDateTime}`;
    })()
    : "";
  const embeddableEventPath = normalizeEmbeddableEverycalPath(
    event.slug && event.account?.username
      ? `/@${event.account.username}/${event.slug}`
      : location
  );
  const canEmbedEvent = (event.visibility === "public" || event.visibility === "unlisted") && !!embeddableEventPath;
  const canRepostEvent = !!user && !isCanceled && event.source !== "remote" && event.accountId !== user.id;
  const canRepostAs = canRepostEvent && !identitiesLoading && hasAdditionalIdentities;
  const showEventMenu = canEmbedEvent || canRepostAs;

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
              <span
                className={showViewerTimezoneTooltip ? "inline-time-tooltip-anchor" : undefined}
                tabIndex={showViewerTimezoneTooltip ? 0 : undefined}
                aria-describedby={showViewerTimezoneTooltip && viewerTimezoneDateLabel ? viewerTimezoneTooltipId : undefined}
              >
                {eventDateLabel}
                {showViewerTimezoneTooltip && (
                  <span id={viewerTimezoneTooltipId} role="tooltip" className="inline-time-tooltip-bubble">{viewerTimezoneDateLabel}</span>
                )}
              </span>
            </span>
            {event.visibility !== "public" && (
              <span className={`visibility-badge ${event.visibility}`} style={{ alignSelf: "flex-start" }}>
                {event.visibility === "followers_only" ? t("followersOnly") : event.visibility === "private" ? t("onlyMe") : event.visibility === "unlisted" ? t("unlisted") : event.visibility}
              </span>
            )}
          </div>

          {canManageEvent && (
            <div className="flex gap-1" style={{ alignItems: "center" }}>
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

        {((user && !isCanceled) || showEventMenu) && (
          <div
            className="flex gap-1 mb-4"
            style={{ flexWrap: "wrap", alignItems: "center" }}
          >
            {user && !isCanceled && (
              <>
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
              </>
            )}
            {showEventMenu && (
              <div ref={eventMenuRef} style={{ position: "relative" }}>
                <button
                  ref={eventMenuButtonRef}
                  type="button"
                  className="profile-menu-btn"
                  onClick={() => setEventActionMenuOpen((open) => !open)}
                  aria-expanded={eventActionMenuOpen}
                  aria-haspopup="menu"
                  aria-controls={eventActionMenuOpen ? eventMenuId : undefined}
                  aria-label={t("common:menu")}
                  title={t("common:menu")}
                >
                  <MenuIcon />
                </button>
                {eventActionMenuOpen && (
                  <div id={eventMenuId} className="header-dropdown" role="menu">
                    {canRepostAs && (
                      <button
                        type="button"
                        className="header-dropdown-item"
                        role="menuitem"
                        onClick={() => {
                          setEventActionMenuOpen(false);
                          setRepostAsError(null);
                          setRepostAsOpen(true);
                        }}
                      >
                        {t("common:repostAs")}
                      </button>
                    )}
                    {canEmbedEvent && (
                      <button
                        type="button"
                        className="header-dropdown-item"
                        role="menuitem"
                        onClick={() => {
                          setEventActionMenuOpen(false);
                          setEmbedModalOpen(true);
                        }}
                      >
                        {t("common:copyEmbedCode")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {repostAsError && <p className="error-text mb-2" role="alert">{repostAsError}</p>}

        {event.description && (
          <div
            className="event-description"
            dangerouslySetInnerHTML={{
              __html: sanitizeHtmlWithNewlines(event.description),
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
          <div className="flex gap-1 mt-2" style={{ flexWrap: "wrap", alignItems: "center", minWidth: 0, width: "100%" }}>
            {event.tags.map((tag) => (
              <Link
                key={tag}
                href={eventsPathWithTags([tag])}
                className="tag tag-clickable"
              >
                {tag}
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

      {repostAsOpen && user && event.source !== "remote" && event.accountId !== user.id && (
        <ActAsActionModal
          open
          onClose={() => setRepostAsOpen(false)}
          onComplete={(errorMessage) => setRepostAsError(errorMessage)}
          excludedAccountIds={event.accountId ? [event.accountId] : undefined}
          actionKind="repost"
          loadState={() => eventsApi.repostActors(event.id)}
          apply={async (desiredAccountIds) => {
            const res = await eventsApi.setRepostActors(event.id, desiredAccountIds);
            const me = res.results.find((row) => row.accountId === user.id);
            if (me && me.status !== "error") {
              setReposted(!!me.after);
            }
            return res;
          }}
        />
      )}

      {embedModalOpen && embeddableEventPath && canEmbedEvent && (
        <EmbedCodeModal
          open
          onClose={() => setEmbedModalOpen(false)}
          path={embeddableEventPath}
        />
      )}
    </div>
  );
}
