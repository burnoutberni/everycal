/**
 * ActivityPub routes — actor profiles, inbox, outbox, followers, following.
 *
 * GET  /users/:username           — Actor profile (with content negotiation)
 * GET  /users/:username/outbox    — OrderedCollection of Create(Event) + Announce activities
 * GET  /users/:username/followers — OrderedCollection of followers
 * GET  /users/:username/following — OrderedCollection of following
 * POST /users/:username/inbox     — Receive activities (Follow, Undo, Create, etc.)
 * GET  /events/:id                — Event object (for federation, Accept: application/activity+json)
 */

import { Hono } from "hono";
import type { Context } from "hono";
import crypto from "node:crypto";
import type { DB } from "../db.js";
import { generateKeyPair, verifySignature } from "../lib/crypto.js";
import {
  resolveRemoteActor,
  deliverActivity,
} from "../lib/federation.js";
import { stripHtml } from "../lib/security.js";
import { notifyEventUpdated, notifyEventCancelled } from "../lib/notifications.js";
import { fallbackSlugFromUri } from "../lib/event-links.js";
import { upsertRemoteEvent } from "../lib/remote-events.js";
import { getLocale, t } from "../lib/i18n.js";
import { normalizeApTemporal } from "../lib/timezone.js";

const AP_CONTENT_TYPES = [
  "application/activity+json",
  "application/ld+json",
];

const AP_CONTEXT = "https://www.w3.org/ns/activitystreams";
const EVERYCAL_CONTEXT = {
  eventTimezone: "https://everycal.org/ns#eventTimezone",
};

function isAPRequest(accept: string): boolean {
  return AP_CONTENT_TYPES.some((t) => accept.includes(t));
}

function getBaseUrl(): string {
  return process.env.BASE_URL || "http://localhost:3000";
}

/** Convert SQLite datetime to ISO 8601 for ActivityPub (required by spec). */
function toISO8601(dt: string | null | undefined): string | undefined {
  if (!dt) return undefined;
  if (dt.includes("T")) return dt.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dt) ? dt : dt + "Z";
  const normalized = dt.replace(" ", "T");
  return normalized.includes(".") ? normalized + "Z" : normalized + ".000Z";
}

function toUtcIsoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function toDateOnlyOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s)/);
  return match ? match[1] : undefined;
}

function toEpochMillisOrZero(value: unknown): number {
  const iso = toUtcIsoOrUndefined(value);
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function ensureKeyPair(db: DB, accountId: string): { publicKey: string; privateKey: string } {
  const row = db
    .prepare("SELECT public_key, private_key FROM accounts WHERE id = ?")
    .get(accountId) as { public_key: string | null; private_key: string | null };

  if (row.public_key && row.private_key) {
    return { publicKey: row.public_key, privateKey: row.private_key };
  }

  const keys = generateKeyPair();
  db.prepare("UPDATE accounts SET public_key = ?, private_key = ? WHERE id = ?").run(
    keys.publicKey,
    keys.privateKey,
    accountId
  );
  return keys;
}

export function activityPubRoutes(db: DB): Hono {
  const router = new Hono();

  // ---- Actor Profile ----
  router.get("/:username", (c) => {
    const username = c.req.param("username");
    const accept = c.req.header("accept") || "";

    // Only serve AP JSON when explicitly requested
    if (!isAPRequest(accept)) {
      // Let it fall through to other handlers (or return 406)
      return c.json({ error: t(getLocale(c), "activitypub.accept_activity_json") }, 406);
    }

    const account = db
      .prepare("SELECT * FROM accounts WHERE username = ?")
      .get(username) as Record<string, unknown> | undefined;

    if (!account) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    const keys = ensureKeyPair(db, account.id as string);
    const baseUrl = getBaseUrl();
    const actorUrl = `${baseUrl}/users/${username}`;

    const attachment: Record<string, unknown>[] = [];
    if (account.website) {
      attachment.push({
        type: "PropertyValue",
        name: "Website",
        value: `<a href="${account.website}" rel="me nofollow noopener noreferrer" target="_blank">${account.website}</a>`,
      });
    }

    const actor = {
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://w3id.org/security/v1",
      ],
      id: actorUrl,
      type: "Person",
      preferredUsername: username,
      name: (account.display_name as string) || username,
      summary: (account.bio as string) || "",
      url: `${baseUrl}/@${username}`,
      ...(account.created_at ? { published: toISO8601(account.created_at as string) } : {}),
      inbox: `${actorUrl}/inbox`,
      outbox: `${actorUrl}/outbox`,
      followers: `${actorUrl}/followers`,
      following: `${actorUrl}/following`,
      manuallyApprovesFollowers: false,
      discoverable: true,
      publicKey: {
        id: `${actorUrl}#main-key`,
        owner: actorUrl,
        publicKeyPem: keys.publicKey,
      },
      ...(account.avatar_url ? {
        icon: {
          type: "Image" as const,
          url: account.avatar_url as string,
        },
      } : {}),
      ...(attachment.length > 0 ? { attachment } : {}),
      endpoints: {
        sharedInbox: `${baseUrl}/inbox`,
      },
    };

    return c.json(actor, 200, {
      "Content-Type": "application/activity+json; charset=utf-8",
    });
  });

  // ---- Outbox ----
  router.get("/:username/outbox", (c) => {
    const username = c.req.param("username");
    const page = c.req.query("page");
    const baseUrl = getBaseUrl();
    const actorUrl = `${baseUrl}/users/${username}`;

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    // Count: owned public events + explicit reposts + auto-reposted events
    const ownedCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM events WHERE account_id = ? AND visibility = 'public'"
        )
        .get(account.id) as { cnt: number }
    ).cnt;
    const repostCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM reposts r
           JOIN events e ON e.id = r.event_id
           WHERE r.account_id = ? AND e.visibility IN ('public', 'unlisted')`
        )
        .get(account.id) as { cnt: number }
    ).cnt;
    const autoRepostCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM auto_reposts ar
           JOIN events e ON e.account_id = ar.source_account_id
           WHERE ar.account_id = ? AND e.visibility = 'public'
             AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ?)`
        )
        .get(account.id, account.id) as { cnt: number }
    ).cnt;
    const totalItems = ownedCount + repostCount + autoRepostCount;

    if (!page) {
      return c.json(
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${actorUrl}/outbox`,
          type: "OrderedCollection",
          totalItems,
          first: `${actorUrl}/outbox?page=1`,
        },
        200,
        { "Content-Type": "application/activity+json; charset=utf-8" }
      );
    }

    // Build activities: Create for owned events, Announce for reposts
    const ownedRows = db
      .prepare(
        `SELECT e.*, GROUP_CONCAT(t.tag) AS tags
         FROM events e
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE e.account_id = ? AND e.visibility = 'public'
         GROUP BY e.id`
      )
      .all(account.id) as Record<string, unknown>[];

    const repostRows = db
      .prepare(
        `SELECT r.created_at AS reposted_at, e.*, GROUP_CONCAT(t.tag) AS tags
         FROM reposts r
         JOIN events e ON e.id = r.event_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE r.account_id = ? AND e.visibility IN ('public', 'unlisted')
         GROUP BY e.id`
      )
      .all(account.id) as Record<string, unknown>[];

    const autoRepostRows = db
      .prepare(
        `SELECT ar.created_at AS reposted_at, e.*, GROUP_CONCAT(t.tag) AS tags
         FROM auto_reposts ar
         JOIN events e ON e.account_id = ar.source_account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE ar.account_id = ? AND e.visibility = 'public'
           AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ?)
         GROUP BY e.id`
      )
      .all(account.id, account.id) as Record<string, unknown>[];

    const eventUrl = (id: string) => `${baseUrl}/events/${id}`;
    const createItems = ownedRows.map((row) => ({
      id: `${baseUrl}/events/${row.id}/activity`,
      type: "Create",
      actor: actorUrl,
      published: toISO8601(row.created_at as string) ?? row.created_at,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorUrl}/followers`],
      object: rowToAPEvent(row, actorUrl, baseUrl),
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));

    const repostAnnounceItems = repostRows.map((row) => ({
      id: `${actorUrl}/announce/${row.id}`,
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorUrl}/followers`],
      object: eventUrl(row.id as string),
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));
    const autoRepostAnnounceItems = autoRepostRows.map((row) => ({
      id: `${actorUrl}/announce/${row.id}`,
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorUrl}/followers`],
      object: eventUrl(row.id as string),
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));

    // Merge and sort by event start date (desc = newest first)
    const allItems = [...createItems, ...repostAnnounceItems, ...autoRepostAnnounceItems].sort(
      (a, b) => b._sortMs - a._sortMs
    );

    // Paginate
    const pageNum = parseInt(page, 10) || 1;
    const limit = 20;
    const offset = (pageNum - 1) * limit;
    const pageItems = allItems.slice(offset, offset + limit);

    const orderedItems = pageItems.map(({ _sortMs, ...item }) => item);

    const result: Record<string, unknown> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorUrl}/outbox?page=${pageNum}`,
      type: "OrderedCollectionPage",
      partOf: `${actorUrl}/outbox`,
      orderedItems,
    };

    if (pageItems.length === limit) {
      result.next = `${actorUrl}/outbox?page=${pageNum + 1}`;
    }

    return c.json(result, 200, {
      "Content-Type": "application/activity+json; charset=utf-8",
    });
  });

  // ---- Followers Collection ----
  router.get("/:username/followers", (c) => {
    const username = c.req.param("username");
    const baseUrl = getBaseUrl();
    const actorUrl = `${baseUrl}/users/${username}`;

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    // Count remote + local followers
    const remoteCount = (
      db
        .prepare("SELECT COUNT(*) AS cnt FROM remote_follows WHERE account_id = ?")
        .get(account.id) as { cnt: number }
    ).cnt;

    const localCount = (
      db
        .prepare("SELECT COUNT(*) AS cnt FROM follows WHERE following_id = ?")
        .get(account.id) as { cnt: number }
    ).cnt;

    return c.json(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${actorUrl}/followers`,
        type: "OrderedCollection",
        totalItems: remoteCount + localCount,
      },
      200,
      { "Content-Type": "application/activity+json; charset=utf-8" }
    );
  });

  // ---- Following Collection ----
  router.get("/:username/following", (c) => {
    const username = c.req.param("username");
    const baseUrl = getBaseUrl();
    const actorUrl = `${baseUrl}/users/${username}`;

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    const localCount = (
      db
        .prepare("SELECT COUNT(*) AS cnt FROM follows WHERE follower_id = ?")
        .get(account.id) as { cnt: number }
    ).cnt;

    return c.json(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${actorUrl}/following`,
        type: "OrderedCollection",
        totalItems: localCount,
      },
      200,
      { "Content-Type": "application/activity+json; charset=utf-8" }
    );
  });

  // ---- Inbox (receive activities) ----
  router.post("/:username/inbox", async (c) => {
    const username = c.req.param("username");
    const account = db
      .prepare("SELECT id, username FROM accounts WHERE username = ?")
      .get(username) as { id: string; username: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    // Read raw body for digest verification, then parse JSON
    const rawBody = await c.req.text();
    let activity: Record<string, unknown>;
    try {
      activity = JSON.parse(rawBody);
    } catch {
      return c.json({ error: t(getLocale(c), "common.invalid_json") }, 400);
    }

    const type = activity.type as string;
    const actorUri = activity.actor as string;

    // Verify the incoming activity has a valid HTTP Signature
    if (actorUri) {
      // SKIP_SIGNATURE_VERIFY is only allowed in non-production environments
      const skipVerify = process.env.SKIP_SIGNATURE_VERIFY === "true" && process.env.NODE_ENV !== "production";
      if (!skipVerify) {
        const verified = await verifyInboxSignature(db, c, actorUri, rawBody);
        if (!verified) {
          console.log(`  ⚠️  Signature verification failed for ${actorUri}`);
          return c.json({ error: t(getLocale(c), "common.invalid_signature") }, 401);
        }
      }
    }

    console.log(`📬 Inbox for ${username}: ${type} from ${actorUri}`);

    switch (type) {
      case "Follow":
        await handleFollow(db, account, activity);
        break;
      case "Undo":
        await handleUndo(db, account, activity);
        break;
      case "Create":
      case "Update":
        handleCreateUpdate(db, activity, type);
        break;
      case "Delete":
        handleDelete(db, activity);
        break;
      default:
        console.log(`  ⏭ Ignored activity type: ${type}`);
    }

    return c.json({ ok: true }, 202);
  });

  return router;
}

/**
 * Shared inbox — receives activities addressed to multiple local accounts.
 */
export function sharedInboxRoute(db: DB): Hono {
  const router = new Hono();

  router.post("/inbox", async (c) => {
    // Read raw body for digest verification, then parse JSON
    const rawBody = await c.req.text();
    let activity: Record<string, unknown>;
    try {
      activity = JSON.parse(rawBody);
    } catch {
      return c.json({ error: t(getLocale(c), "common.invalid_json") }, 400);
    }

    const type = activity.type as string;
    const actorUri = activity.actor as string;

    // Verify HTTP Signature
    if (actorUri) {
      const skipVerify = process.env.SKIP_SIGNATURE_VERIFY === "true" && process.env.NODE_ENV !== "production";
      if (!skipVerify) {
        const verified = await verifyInboxSignature(db, c, actorUri, rawBody);
        if (!verified) {
          console.log(`  ⚠️  Shared inbox signature verification failed for ${actorUri}`);
          return c.json({ error: t(getLocale(c), "common.invalid_signature") }, 401);
        }
      }
    }

    console.log(`📬 Shared inbox: ${type} from ${actorUri}`);

    switch (type) {
      case "Follow": {
        // Find the target local account from the Follow object.
        // ActivityPub allows object to be either a string IRI or an object with id.
        const objectUri = extractObjectUri(activity.object);
        const baseUrl = getBaseUrl();
        const match = objectUri?.match(new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/users/([^/]+)$`));
        if (match) {
          const account = db
            .prepare("SELECT id, username FROM accounts WHERE username = ?")
            .get(match[1]) as { id: string; username: string } | undefined;
          if (account) await handleFollow(db, account, activity);
        } else if (objectUri) {
          console.log(`  ⚠️  Follow object URI did not match local user pattern: ${objectUri}`);
        }
        break;
      }
      case "Undo": {
        const inner = activity.object as Record<string, unknown>;
        if (inner?.type === "Follow") {
          const objectUri = extractObjectUri(inner.object);
          const baseUrl = getBaseUrl();
          const match = objectUri?.match(new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/users/([^/]+)$`));
          if (match) {
            const account = db
              .prepare("SELECT id, username FROM accounts WHERE username = ?")
              .get(match[1]) as { id: string; username: string } | undefined;
            if (account) await handleUndo(db, account, activity);
          }
        }
        break;
      }
      case "Create":
      case "Update":
        handleCreateUpdate(db, activity, type);
        break;
      case "Delete":
        handleDelete(db, activity);
        break;
    }

    return c.json({ ok: true }, 202);
  });

  return router;
}

// ---- Activity Handlers ----

async function handleFollow(
  db: DB,
  account: { id: string; username: string },
  activity: Record<string, unknown>
) {
  const actorUri = activity.actor as string;
  if (!actorUri) return;

  // Resolve the remote actor to get their inbox
  const remoteActor = await resolveRemoteActor(db, actorUri);
  if (!remoteActor) {
    console.error(`  ❌ Could not resolve actor: ${actorUri}`);
    return;
  }

  // Store the follow
  db.prepare(
    `INSERT OR REPLACE INTO remote_follows (account_id, follower_actor_uri, follower_inbox, follower_shared_inbox)
     VALUES (?, ?, ?, ?)`
  ).run(account.id, actorUri, remoteActor.inbox, remoteActor.shared_inbox);

  console.log(`  ✅ ${actorUri} now follows ${account.username}`);

  // Send Accept
  const keys = ensureKeyPairForAccount(db, account.id);
  const baseUrl = getBaseUrl();
  const actorUrl = `${baseUrl}/users/${account.username}`;

  const accept = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actorUrl}#accept-${Date.now()}`,
    type: "Accept",
    actor: actorUrl,
    object: activity,
  };

  await deliverActivity(
    remoteActor.inbox,
    accept,
    keys.privateKey,
    `${actorUrl}#main-key`
  );
  console.log(`  📤 Sent Accept to ${remoteActor.inbox}`);
}

async function handleUndo(
  db: DB,
  account: { id: string; username: string },
  activity: Record<string, unknown>
) {
  const inner = activity.object as Record<string, unknown>;
  if (!inner || inner.type !== "Follow") return;

  const actorUri = activity.actor as string;
  db.prepare(
    "DELETE FROM remote_follows WHERE account_id = ? AND follower_actor_uri = ?"
  ).run(account.id, actorUri);

  console.log(`  ✅ ${actorUri} unfollowed ${account.username}`);
}


function actorHandleFromUri(actorUri: string): { username: string; domain?: string } {
  try {
    const u = new URL(actorUri);
    const raw = u.pathname.split("/").filter(Boolean).pop() || "unknown";
    const username = raw.startsWith("@") ? raw.slice(1) : raw;
    return { username, domain: u.host };
  } catch {
    return { username: "unknown" };
  }
}

function handleCreateUpdate(db: DB, activity: Record<string, unknown>, activityType: string) {
  const object = activity.object as Record<string, unknown>;
  if (!object || object.type !== "Event") return;

  // Validate that actor matches attributedTo (prevent impersonation)
  const rawAttributedTo = object.attributedTo;
  const attributedTo =
    typeof rawAttributedTo === "string"
      ? rawAttributedTo
      : Array.isArray(rawAttributedTo)
        ? (rawAttributedTo[0] as string)
        : null;
  const actorUri = activity.actor as string;

  // If attributedTo is present, it must match the activity actor
  if (attributedTo && attributedTo !== actorUri) {
    console.log(`  ⚠️  Rejecting Create/Update: actor ${actorUri} != attributedTo ${attributedTo}`);
    return;
  }

  const effectiveActor = attributedTo || actorUri;
  // Sanitize content from remote servers
  const title = typeof object.name === "string" ? stripHtml(object.name) : "";
  // Extract location
  const loc = object.location as Record<string, unknown> | undefined;
  let locationAddress: string | null = null;
  if (loc?.address) {
    if (typeof loc.address === "string") {
      locationAddress = loc.address;
    } else {
      const addr = loc.address as Record<string, string>;
      locationAddress = [addr.streetAddress, addr.postalCode, addr.addressLocality, addr.addressCountry]
        .filter(Boolean)
        .join(", ");
    }
  }

  const uri = object.id as string;
  const temporal = normalizeApTemporal(object);
  if (!temporal) return;
  const startDate = temporal.startDate;
  const endDate = temporal.endDate;
  const locationName = loc?.name ? stripHtml(loc.name as string) : null;
  const locationAddr = locationAddress ? stripHtml(locationAddress) : null;

  // For Update: fetch existing to detect material changes and notify RSVP'd users.
  // Only title, time, and location trigger notifications (not description, image, url, tags).
  let changes: { field: "title" | "time" | "location"; before?: string; after?: string }[] = [];
  if (activityType === "Update") {
    const existing = db.prepare(
      "SELECT title, start_date, end_date, all_day, location_name, location_address FROM remote_events WHERE uri = ?"
    ).get(uri) as { title: string; start_date: string; end_date: string | null; all_day: number; location_name: string | null; location_address: string | null } | undefined;
    if (existing) {
      if (existing.title !== title) changes.push({ field: "title", before: existing.title, after: title });
      if (existing.start_date !== startDate || existing.end_date !== endDate || !!existing.all_day !== temporal.allDay) {
        const oldMode = existing.all_day ? "all-day" : "timed";
        const newMode = temporal.allDay ? "all-day" : "timed";
        const oldTime = `${[existing.start_date, existing.end_date || ""].filter(Boolean).join(" – ")} (${oldMode})`;
        const newTime = `${[startDate, endDate || ""].filter(Boolean).join(" – ")} (${newMode})`;
        changes.push({ field: "time", before: oldTime, after: newTime });
      }
      const oldLoc = [existing.location_name || "", existing.location_address || ""].filter(Boolean).join(", ");
      const newLoc = [locationName || "", locationAddr || ""].filter(Boolean).join(", ");
      if (oldLoc !== newLoc) changes.push({ field: "location", before: oldLoc, after: newLoc });
    }
  }


  upsertRemoteEvent(db, object, effectiveActor, {
    clearCanceled: true,
    temporal,
  });

  if (activityType === "Update" && changes.length > 0) {
    const stored = db.prepare(
      `SELECT re.slug, ra.preferred_username, ra.domain
       FROM remote_events re
       JOIN remote_actors ra ON ra.uri = re.actor_uri
       WHERE re.uri = ?`
    ).get(uri) as { slug: string | null; preferred_username: string; domain: string } | undefined;
    const fallbackAccount = actorHandleFromUri(effectiveActor);

    notifyEventUpdated(db, uri, {
      id: uri,
      title,
      slug: stored?.slug || fallbackSlugFromUri(uri),
      account: stored
        ? { username: stored.preferred_username, domain: stored.domain }
        : { username: fallbackAccount.username, domain: fallbackAccount.domain },
      startDate,
      endDate,
      allDay: temporal.allDay,
      location: locationName ? { name: locationName } : null,
      url: (object.url as string) || null,
    }, changes);
  }

  console.log(`  ✅ Stored remote event: ${object.name}`);
}

function handleDelete(db: DB, activity: Record<string, unknown>) {
  const actorUri = activity.actor as string;
  const rawObject = activity.object;
  const objectUri: string | undefined =
    typeof rawObject === "string"
      ? rawObject
      : (rawObject as Record<string, unknown> | null)?.id as string | undefined;

  if (objectUri && actorUri) {
    // Only mark canceled if the event belongs to the actor sending the Delete
    const existing = db.prepare(
      "SELECT actor_uri, slug, title, start_date, end_date, all_day, location_name, url FROM remote_events WHERE uri = ?"
    ).get(objectUri) as
      | { actor_uri: string; slug: string | null; title: string; start_date: string; end_date: string | null; all_day: number; location_name: string | null; url: string | null }
      | undefined;
    if (existing && existing.actor_uri === actorUri) {
      db.prepare("UPDATE remote_events SET canceled = 1 WHERE uri = ?").run(objectUri);
      const actor = db
        .prepare("SELECT preferred_username, domain FROM remote_actors WHERE uri = ?")
        .get(existing.actor_uri) as { preferred_username: string; domain: string } | undefined;
      const fallbackAccount = actorHandleFromUri(existing.actor_uri);
      notifyEventCancelled(db, objectUri, {
        id: objectUri,
        title: existing.title,
        slug: existing.slug || fallbackSlugFromUri(objectUri),
        account: actor
          ? { username: actor.preferred_username, domain: actor.domain }
          : { username: fallbackAccount.username, domain: fallbackAccount.domain },
        startDate: existing.start_date,
        endDate: existing.end_date,
        allDay: !!existing.all_day,
        location: existing.location_name ? { name: existing.location_name } : null,
        url: existing.url,
      });
      console.log(`  🚫 Marked remote event as canceled: ${objectUri}`);
    } else if (existing) {
      console.log(`  ⚠️  Rejecting Delete: actor ${actorUri} doesn't own event ${objectUri} (owner: ${existing.actor_uri})`);
    }
  }
}

function ensureKeyPairForAccount(
  db: DB,
  accountId: string
): { publicKey: string; privateKey: string } {
  const row = db
    .prepare("SELECT public_key, private_key FROM accounts WHERE id = ?")
    .get(accountId) as { public_key: string | null; private_key: string | null };

  if (row.public_key && row.private_key) {
    return { publicKey: row.public_key, privateKey: row.private_key };
  }

  const keys = generateKeyPair();
  db.prepare("UPDATE accounts SET public_key = ?, private_key = ? WHERE id = ?").run(
    keys.publicKey,
    keys.privateKey,
    accountId
  );
  return keys;
}

// ---- Helpers ----

/** Extract URI from ActivityPub object (string IRI or object with id). */
function extractObjectUri(obj: unknown): string | undefined {
  if (typeof obj === "string") return obj;
  if (obj && typeof obj === "object" && "id" in obj && typeof (obj as Record<string, unknown>).id === "string") {
    return (obj as Record<string, string>).id;
  }
  return undefined;
}

function rowToAPEvent(
  row: Record<string, unknown>,
  actorUrl: string,
  baseUrl: string
): Record<string, unknown> {
  const eventUrl = `${baseUrl}/events/${row.id}`;
  const tags = row.tags ? (row.tags as string).split(",") : [];
  const isAllDay = !!row.all_day;
  const startDateOnly = toDateOnlyOrUndefined(row.start_date);
  const endDateOnly = toDateOnlyOrUndefined(row.end_date);
  const startUtc = toUtcIsoOrUndefined(row.start_at_utc);
  const endUtc = toUtcIsoOrUndefined(row.end_at_utc);
  if (isAllDay && !startDateOnly) throw new Error("All-day event missing date-only start_date");
  if (!isAllDay && !startUtc) throw new Error("Event missing start_at_utc");

  const event: Record<string, unknown> = {
    "@context": [AP_CONTEXT, EVERYCAL_CONTEXT],
    id: eventUrl,
    type: "Event",
    name: row.title,
    startTime: isAllDay ? startDateOnly : startUtc,
    published: toISO8601(row.created_at as string) ?? row.created_at,
    updated: toISO8601(row.updated_at as string) ?? row.updated_at,
    url: (row.url as string) || eventUrl,
    attributedTo: actorUrl,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${actorUrl}/followers`],
  };

  if (row.description) event.content = row.description;
  if (isAllDay) {
    if (endDateOnly) event.endTime = endDateOnly;
  } else if (endUtc) {
    event.endTime = endUtc;
  }
  if (row.event_timezone) event.eventTimezone = row.event_timezone;
  if (row.location_name) {
    const location: Record<string, unknown> = {
      type: "Place",
      name: row.location_name,
    };
    if (row.location_address) {
      location.address = {
        type: "PostalAddress",
        streetAddress: row.location_address,
      };
    }
    if (row.location_latitude != null) location.latitude = row.location_latitude;
    if (row.location_longitude != null) location.longitude = row.location_longitude;
    event.location = location;
  }

  const attachments: Record<string, unknown>[] = [];
  if (row.image_url) {
    const attachment: Record<string, unknown> = {
      type: "Document",
      url: row.image_url,
      mediaType: row.image_media_type || "image/jpeg",
      name: row.image_alt || "",
    };
    if (row.image_attribution) {
      try {
        attachment.attribution = JSON.parse(row.image_attribution as string) as Record<string, unknown>;
      } catch {
        // Ignore invalid JSON
      }
    }
    attachments.push(attachment);
  }
  if (attachments.length > 0) event.attachment = attachments;

  if (tags.length > 0) {
    event.tag = tags.map((t) => ({
      type: "Hashtag",
      name: t.startsWith("#") ? t : `#${t}`,
    }));
  }

  if (row.og_image_url) {
    event.image = {
      type: "Image",
      url: `${baseUrl}${row.og_image_url}`,
    };
  }

  event.mediaType = "text/html";

  return event;
}

/**
 * Verify the HTTP Signature on an incoming ActivityPub inbox request.
 *
 * Fetches the remote actor's public key and validates the signature.
 * Also verifies the Digest header matches the request body.
 * Returns true if valid, false otherwise.
 */
async function verifyInboxSignature(
  db: DB,
  c: Context,
  actorUri: string,
  rawBody: string
): Promise<boolean> {
  try {
    // Verify the Digest header matches the body (prevents body tampering)
    const digestHeader = c.req.header("digest");
    if (!digestHeader) {
      console.log(`  ⚠️  Missing Digest header from ${actorUri}`);
      return false;
    }
    const expectedDigest = `SHA-256=${crypto.createHash("sha256").update(rawBody).digest("base64")}`;
    if (digestHeader !== expectedDigest) {
      console.log(`  ⚠️  Digest mismatch for ${actorUri}`);
      return false;
    }

    // Resolve the actor to get their public key
    const actor = await resolveRemoteActor(db, actorUri);
    if (!actor?.public_key_pem) {
      console.log(`  ⚠️  No public key for actor: ${actorUri}`);
      return false;
    }

    // Build the headers map that verifySignature expects
    const headerMap: Record<string, string> = {};
    const sigHeader = c.req.header("signature");
    if (!sigHeader) return false;

    headerMap["signature"] = sigHeader;
    headerMap["host"] = c.req.header("host") || "";
    headerMap["date"] = c.req.header("date") || "";
    headerMap["digest"] = c.req.header("digest") || "";
    headerMap["content-type"] = c.req.header("content-type") || "";

    const url = new URL(c.req.url);
    return verifySignature("POST", url.pathname, headerMap, actor.public_key_pem);
  } catch (err) {
    console.error(`  ❌ Signature verification error:`, err);
    return false;
  }
}

/** ActivityPub event object route — GET /events/:id serves Event JSON for federation. */
export function activityPubEventRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    const accept = c.req.header("accept") || "";

    if (!isAPRequest(accept)) {
      return c.json({ error: t(getLocale(c), "activitypub.request_accept_activity_json") }, 406);
    }

    const row = db
      .prepare(
        `SELECT e.*, a.username, GROUP_CONCAT(t.tag) AS tags
         FROM events e
         JOIN accounts a ON a.id = e.account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE e.id = ? AND e.visibility = 'public'
         GROUP BY e.id`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    const baseUrl = getBaseUrl();
    const actorUrl = `${baseUrl}/users/${row.username}`;
    const event = rowToAPEvent(row, actorUrl, baseUrl);

    return c.json(event, 200, {
      "Content-Type": "application/activity+json; charset=utf-8",
    });
  });

  return router;
}
