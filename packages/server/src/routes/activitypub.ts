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
  deliverToFollowers,
} from "../lib/federation.js";
import { stripHtml, sanitizeHtml } from "../lib/security.js";
import { notifyEventUpdated, notifyEventCancelled } from "../lib/notifications.js";
import { getLocale, t } from "../lib/i18n.js";

const AP_CONTENT_TYPES = [
  "application/activity+json",
  "application/ld+json",
];

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
      _sort: row.start_date as string,
    }));

    const repostAnnounceItems = repostRows.map((row) => ({
      id: `${actorUrl}/announce/${row.id}`,
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorUrl}/followers`],
      object: eventUrl(row.id as string),
      _sort: row.start_date as string,
    }));
    const autoRepostAnnounceItems = autoRepostRows.map((row) => ({
      id: `${actorUrl}/announce/${row.id}`,
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorUrl}/followers`],
      object: eventUrl(row.id as string),
      _sort: row.start_date as string,
    }));

    // Merge and sort by event start date (desc = newest first)
    const allItems = [...createItems, ...repostAnnounceItems, ...autoRepostAnnounceItems].sort((a, b) =>
      (b._sort || "").localeCompare(a._sort || "")
    );

    // Paginate
    const pageNum = parseInt(page, 10) || 1;
    const limit = 20;
    const offset = (pageNum - 1) * limit;
    const pageItems = allItems.slice(offset, offset + limit);

    const orderedItems = pageItems.map(({ _sort, ...item }) => item);

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
  const tags = (object.tag as Array<{ name: string }>) || [];
  const tagString = tags.map((t) => stripHtml(t.name?.replace(/^#/, "") || "")).filter(Boolean).join(",");

  // Sanitize content from remote servers
  const title = typeof object.name === "string" ? stripHtml(object.name) : "";
  const description = typeof object.content === "string" ? sanitizeHtml(object.content) : null;

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

  // Extract first image from attachments
  const attachments = (object.attachment as Array<Record<string, unknown>>) || [];
  const image = attachments.find(
    (a) => a.type === "Image" || a.type === "Document"
  );

  const imageAttribution = image?.attribution
    ? (typeof image.attribution === "string"
        ? (() => { try { return JSON.parse(image.attribution as string); } catch { return null; } })()
        : image.attribution)
    : null;
  const imageAttributionJson = imageAttribution && typeof imageAttribution === "object"
    ? JSON.stringify(imageAttribution)
    : null;

  const uri = object.id as string;
  const startDate = object.startTime as string;
  const endDate = (object.endTime as string) || null;
  const locationName = loc?.name ? stripHtml(loc.name as string) : null;
  const locationAddr = locationAddress ? stripHtml(locationAddress) : null;

  // For Update: fetch existing to detect material changes and notify RSVP'd users.
  // Only title, time, and location trigger notifications (not description, image, url, tags).
  let changes: string[] = [];
  if (activityType === "Update") {
    const existing = db.prepare(
      "SELECT title, start_date, end_date, location_name, location_address FROM remote_events WHERE uri = ?"
    ).get(uri) as { title: string; start_date: string; end_date: string | null; location_name: string | null; location_address: string | null } | undefined;
    if (existing) {
      if (existing.title !== title) changes.push("title");
      if (existing.start_date !== startDate || existing.end_date !== endDate) changes.push("time");
      const locChanged = (existing.location_name || "") !== (locationName || "") || (existing.location_address || "") !== (locationAddr || "");
      if (locChanged) changes.push("location");
    }
  }

  db.prepare(
    `INSERT INTO remote_events (uri, actor_uri, title, description, start_date, end_date,
      location_name, location_address, location_latitude, location_longitude,
      image_url, image_media_type, image_alt, image_attribution, url, tags, raw_json, published, updated, canceled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(uri) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      start_date=excluded.start_date, end_date=excluded.end_date,
      location_name=excluded.location_name, location_address=excluded.location_address,
      location_latitude=excluded.location_latitude, location_longitude=excluded.location_longitude,
      image_url=excluded.image_url, image_media_type=excluded.image_media_type,
      image_alt=excluded.image_alt, image_attribution=excluded.image_attribution,
      url=excluded.url, tags=excluded.tags,
      raw_json=excluded.raw_json, updated=excluded.updated, fetched_at=datetime('now'),
      canceled=excluded.canceled`
  ).run(
    uri,
    effectiveActor,
    title,
    description,
    startDate,
    endDate,
    locationName,
    locationAddr,
    (loc?.latitude as number) ?? null,
    (loc?.longitude as number) ?? null,
    (image?.url as string) || null,
    (image?.mediaType as string) || null,
    (image?.name as string) || null,
    imageAttributionJson,
    (object.url as string) || null,
    tagString || null,
    // Limit raw_json to 100KB to prevent storage abuse
    JSON.stringify(object).slice(0, 100_000),
    (object.published as string) || null,
    (object.updated as string) || null
  );

  if (activityType === "Update" && changes.length > 0) {
    notifyEventUpdated(db, uri, {
      id: uri,
      title,
      startDate,
      endDate,
      allDay: false,
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
      "SELECT actor_uri, title, start_date, end_date, location_name, url FROM remote_events WHERE uri = ?"
    ).get(objectUri) as
      | { actor_uri: string; title: string; start_date: string; end_date: string | null; location_name: string | null; url: string | null }
      | undefined;
    if (existing && existing.actor_uri === actorUri) {
      db.prepare("UPDATE remote_events SET canceled = 1 WHERE uri = ?").run(objectUri);
      notifyEventCancelled(db, objectUri, {
        id: objectUri,
        title: existing.title,
        startDate: existing.start_date,
        endDate: existing.end_date,
        allDay: false,
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

  const event: Record<string, unknown> = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: eventUrl,
    type: "Event",
    name: row.title,
    startTime: toISO8601(row.start_date as string) ?? row.start_date,
    published: toISO8601(row.created_at as string) ?? row.created_at,
    updated: toISO8601(row.updated_at as string) ?? row.updated_at,
    url: (row.url as string) || eventUrl,
    attributedTo: actorUrl,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${actorUrl}/followers`],
  };

  if (row.description) event.content = row.description;
  if (row.end_date) event.endTime = toISO8601(row.end_date as string) ?? row.end_date;
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
