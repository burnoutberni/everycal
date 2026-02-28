import type { DB } from "../db.js";
import type { SsrInitialData } from "@everycal/core";
import type { AuthUser } from "../middleware/auth.js";

export function getSsrInitialData(db: DB, pathname: string, currentUser: AuthUser | null): SsrInitialData {
  const eventMatch = pathname.match(/^\/@([^/]+)\/([^/]+)$/);
  if (eventMatch) {
    const username = decodeURIComponent(eventMatch[1]);
    const slug = decodeURIComponent(eventMatch[2]);
    return {
      kind: "event",
      username,
      slug,
      user: getCurrentUserPayload(db, currentUser),
      event: getEventByProfileSlug(db, username, slug, currentUser),
    };
  }

  const profileMatch = pathname.match(/^\/@([^/]+)$/);
  if (profileMatch) {
    const username = decodeURIComponent(profileMatch[1]);
    return {
      kind: "profile",
      username,
      user: getCurrentUserPayload(db, currentUser),
      profile: getProfileByUsername(db, username, currentUser),
      events: getProfileEvents(db, username, currentUser, 100),
    };
  }

  return null;
}

function getCurrentUserPayload(db: DB, currentUser: AuthUser | null): Record<string, unknown> | null {
  if (!currentUser) return null;
  const row = db
    .prepare(
      `SELECT id, username, display_name, bio, avatar_url, website, is_bot, discoverable, city, city_lat, city_lng, email, email_verified, preferred_language, created_at,
              (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
              (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS followers_count
       FROM accounts WHERE id = ?`
    )
    .get(currentUser.id, currentUser.id, currentUser.id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const prefsRow = db
    .prepare(
      `SELECT reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed
       FROM account_notification_prefs WHERE account_id = ?`
    )
    .get(currentUser.id) as
    | {
        reminder_enabled: number;
        reminder_hours_before: number;
        event_updated_enabled: number;
        event_cancelled_enabled: number;
        onboarding_completed: number;
      }
    | undefined;

  const notificationPrefs = prefsRow
    ? {
        reminderEnabled: !!prefsRow.reminder_enabled,
        reminderHoursBefore: prefsRow.reminder_hours_before,
        eventUpdatedEnabled: !!prefsRow.event_updated_enabled,
        eventCancelledEnabled: !!prefsRow.event_cancelled_enabled,
        onboardingCompleted: !!prefsRow.onboarding_completed,
      }
    : {
        reminderEnabled: true,
        reminderHoursBefore: 24,
        eventUpdatedEnabled: true,
        eventCancelledEnabled: true,
        onboardingCompleted: false,
      };

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    website: row.website || null,
    isBot: !!row.is_bot,
    discoverable: !!row.discoverable,
    city: row.city || null,
    cityLat: row.city_lat != null ? Number(row.city_lat) : null,
    cityLng: row.city_lng != null ? Number(row.city_lng) : null,
    email: row.email || null,
    emailVerified: !!row.email_verified,
    preferredLanguage: row.preferred_language || "en",
    followingCount: row.following_count,
    followersCount: row.followers_count,
    createdAt: row.created_at,
    notificationPrefs,
  };
}

function getProfileByUsername(db: DB, username: string, currentUser: AuthUser | null): Record<string, unknown> | null {
  const atIdx = username.indexOf("@");
  if (atIdx > 0 && atIdx < username.length - 1) {
    const localPart = username.slice(0, atIdx);
    const domain = username.slice(atIdx + 1);
    const remoteRow = db
      .prepare(
        `SELECT ra.uri, ra.preferred_username, ra.display_name, ra.summary, ra.icon_url, ra.image_url, ra.domain,
                ra.followers_count, ra.following_count,
                (SELECT COUNT(*) FROM remote_events WHERE actor_uri = ra.uri) AS events_count
         FROM remote_actors ra WHERE ra.preferred_username = ? AND ra.domain = ?`
      )
      .get(localPart, domain) as Record<string, unknown> | undefined;
    if (!remoteRow) return null;

    const following = currentUser
      ? db
          .prepare("SELECT 1 FROM remote_following WHERE account_id = ? AND actor_uri = ?")
          .get(currentUser.id, remoteRow.uri)
      : null;

    return {
      id: remoteRow.uri,
      username,
      displayName: remoteRow.display_name,
      bio: remoteRow.summary,
      avatarUrl: remoteRow.icon_url,
      website: null,
      isBot: false,
      discoverable: true,
      followersCount: remoteRow.followers_count ?? 0,
      followingCount: remoteRow.following_count ?? 0,
      eventsCount: remoteRow.events_count ?? 0,
      following: !!following,
      autoReposting: false,
      source: "remote",
      domain: remoteRow.domain,
    };
  }

  const row = db
    .prepare(
      `SELECT id, username, display_name, bio, avatar_url, website, is_bot, discoverable, created_at,
              (SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) + (SELECT COUNT(*) FROM remote_follows WHERE account_id = accounts.id) AS followers_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count,
              (SELECT COUNT(*) FROM (
                SELECT e.id FROM events e WHERE e.account_id = accounts.id AND e.visibility IN ('public','unlisted')
                UNION
                SELECT r.event_id FROM reposts r JOIN events e ON e.id = r.event_id WHERE r.account_id = accounts.id AND e.visibility IN ('public','unlisted')
                UNION
                SELECT e.id FROM auto_reposts ar JOIN events e ON e.account_id = ar.source_account_id WHERE ar.account_id = accounts.id AND e.visibility = 'public'
              )) AS events_count
       FROM accounts WHERE username = ?`
    )
    .get(username) as Record<string, unknown> | undefined;
  if (!row) return null;

  const result: Record<string, unknown> = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    website: row.website || null,
    isBot: !!row.is_bot,
    discoverable: !!row.discoverable,
    followersCount: row.followers_count ?? 0,
    followingCount: row.following_count ?? 0,
    eventsCount: row.events_count ?? 0,
    createdAt: row.created_at,
  };

  if (currentUser) {
    const follow = db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
      .get(currentUser.id, row.id);
    const autoRepost = db
      .prepare("SELECT 1 FROM auto_reposts WHERE account_id = ? AND source_account_id = ?")
      .get(currentUser.id, row.id);
    result.following = !!follow;
    result.autoReposting = !!autoRepost;
  }

  return result;
}

function getProfileEvents(db: DB, username: string, currentUser: AuthUser | null, limit: number): Record<string, unknown>[] {
  const atIdx = username.indexOf("@");
  if (atIdx > 0 && atIdx < username.length - 1) {
    const localPart = username.slice(0, atIdx);
    const domain = username.slice(atIdx + 1);
    const remoteActor = db
      .prepare("SELECT uri FROM remote_actors WHERE preferred_username = ? AND domain = ?")
      .get(localPart, domain) as { uri: string } | undefined;
    if (!remoteActor) return [];
    const rows = db
      .prepare(
        `SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
                ra.domain, ra.icon_url AS actor_icon_url
         FROM remote_events re
         LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri
         WHERE re.actor_uri = ?
         ORDER BY re.start_date ASC LIMIT ? OFFSET 0`
      )
      .all(remoteActor.uri, limit) as Record<string, unknown>[];
    return rows.map(formatRemoteEvent);
  }

  const account = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username) as { id: string } | undefined;
  if (!account) return [];

  const isOwner = currentUser?.id === account.id;
  const isFollower = currentUser
    ? !!db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?").get(currentUser.id, account.id)
    : false;

  const allowedVisibilities = ["public", "unlisted"];
  if (isFollower) allowedVisibilities.push("followers_only");
  if (isOwner) allowedVisibilities.push("private");
  const visibilityPlaceholders = allowedVisibilities.map(() => "?").join(",");

  const repostVisibilityClause = currentUser
    ? `AND (
        e.visibility IN ('public','unlisted')
        OR (e.visibility = 'followers_only' AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id))
        OR (e.visibility = 'private' AND e.account_id = ?)
      )`
    : `AND e.visibility IN ('public','unlisted')`;
  const repostVisibilityParams = currentUser ? [currentUser.id, currentUser.id] : [];

  const autoRepostVisibilityClause = currentUser
    ? `AND (
        e.visibility IN ('public','unlisted')
        OR (e.visibility = 'followers_only' AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id))
        OR (e.visibility = 'private' AND e.account_id = ?)
      )`
    : `AND e.visibility IN ('public','unlisted')`;
  const autoRepostVisibilityParams = currentUser ? [currentUser.id, currentUser.id] : [];

  let sql = `
    SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
           GROUP_CONCAT(DISTINCT t.tag) AS tags,
           NULL AS repost_username, NULL AS repost_display_name
    FROM events e
    JOIN accounts a ON a.id = e.account_id
    LEFT JOIN event_tags t ON t.event_id = e.id
    WHERE e.account_id = ?
      AND e.visibility IN (${visibilityPlaceholders})
    GROUP BY e.id
    UNION ALL
    SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
           GROUP_CONCAT(DISTINCT t.tag) AS tags,
           ra.username AS repost_username, ra.display_name AS repost_display_name
    FROM reposts r
    JOIN events e ON e.id = r.event_id
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts ra ON ra.id = r.account_id
    LEFT JOIN event_tags t ON t.event_id = e.id
    WHERE r.account_id = ?
      ${repostVisibilityClause}
    GROUP BY e.id
    UNION ALL
    SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
           GROUP_CONCAT(DISTINCT t.tag) AS tags,
           ra.username AS repost_username, ra.display_name AS repost_display_name
    FROM auto_reposts ar
    JOIN events e ON e.account_id = ar.source_account_id
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts ra ON ra.id = ar.account_id
    LEFT JOIN event_tags t ON t.event_id = e.id
    WHERE ar.account_id = ?
      ${autoRepostVisibilityClause}
      AND e.account_id != ?
      AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ?)
    GROUP BY e.id
    ORDER BY start_date ASC
    LIMIT ? OFFSET 0
  `;

  const params: unknown[] = [
    account.id,
    ...allowedVisibilities,
    account.id,
    ...repostVisibilityParams,
    account.id,
    ...autoRepostVisibilityParams,
    account.id,
    account.id,
    limit,
  ];

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(formatLocalEvent);
}

function getEventByProfileSlug(db: DB, username: string, slug: string, currentUser: AuthUser | null): Record<string, unknown> | null {
  if (username.includes("@")) {
    const eventUri = decodeRemoteEventId(slug);
    const remoteRow = db
      .prepare(
        `SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
                ra.domain, ra.icon_url AS actor_icon_url
         FROM remote_events re
         LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri
         WHERE re.uri = ?`
      )
      .get(eventUri) as Record<string, unknown> | undefined;
    if (!remoteRow) return null;
    const event = formatRemoteEvent(remoteRow);
    if (currentUser) {
      const rsvpRow = db
        .prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
        .get(currentUser.id, eventUri) as { status: string } | undefined;
      event.rsvpStatus = rsvpRow?.status || null;
    }
    return event;
  }

  const row = db
    .prepare(
      `SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
              GROUP_CONCAT(DISTINCT t.tag) AS tags
       FROM events e
       JOIN accounts a ON a.id = e.account_id
       LEFT JOIN event_tags t ON t.event_id = e.id
       WHERE a.username = ? AND e.slug = ?
       GROUP BY e.id`
    )
    .get(username, slug) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (!canViewEvent(db, row.visibility as string, row.account_id as string, currentUser)) return null;

  const event = formatLocalEvent(row);
  if (currentUser) {
    const rsvpRow = db
      .prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
      .get(currentUser.id, row.id) as { status: string } | undefined;
    event.rsvpStatus = rsvpRow?.status || null;
    const repostRow = db.prepare("SELECT 1 FROM reposts WHERE account_id = ? AND event_id = ?").get(currentUser.id, row.id);
    event.reposted = !!repostRow;
  }
  return event;
}

function canViewEvent(db: DB, visibility: string, ownerId: string, currentUser: AuthUser | null): boolean {
  if (visibility === "public" || visibility === "unlisted") return true;
  if (!currentUser) return false;
  if (currentUser.id === ownerId) return true;
  if (visibility === "followers_only") {
    return !!db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
      .get(currentUser.id, ownerId);
  }
  return false;
}

function formatLocalEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    source: "local",
    accountId: row.account_id,
    account: row.account_username
      ? { username: row.account_username, displayName: row.account_display_name }
      : undefined,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: !!row.all_day,
    location: row.location_name
      ? {
          name: row.location_name,
          address: row.location_address,
          latitude: row.location_latitude,
          longitude: row.location_longitude,
          url: row.location_url,
        }
      : null,
    image: row.image_url
      ? {
          url: row.image_url,
          mediaType: row.image_media_type,
          alt: row.image_alt,
          attribution: row.image_attribution
            ? (() => {
                try {
                  return JSON.parse(row.image_attribution as string);
                } catch {
                  return undefined;
                }
              })()
            : undefined,
        }
      : null,
    ogImageUrl: row.og_image_url || null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: row.visibility,
    repostedBy: row.repost_username
      ? { username: row.repost_username as string, displayName: row.repost_display_name as string | null }
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatRemoteEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.uri,
    source: "remote",
    actorUri: row.actor_uri,
    account: row.preferred_username
      ? {
          username: `${row.preferred_username}@${row.domain}`,
          displayName: row.actor_display_name,
          domain: row.domain,
          iconUrl: row.actor_icon_url,
        }
      : null,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: false,
    location: row.location_name
      ? {
          name: row.location_name,
          address: row.location_address,
          latitude: row.location_latitude,
          longitude: row.location_longitude,
        }
      : null,
    image: row.image_url
      ? {
          url: row.image_url,
          mediaType: row.image_media_type,
          alt: row.image_alt,
          attribution: row.image_attribution
            ? (() => {
                try {
                  return JSON.parse(row.image_attribution as string);
                } catch {
                  return undefined;
                }
              })()
            : undefined,
        }
      : null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: "public",
    canceled: !!row.canceled,
    createdAt: row.published,
    updatedAt: row.updated,
  };
}

function decodeRemoteEventId(eventId: string): string {
  try {
    const base64 = eventId.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return eventId;
  }
}
