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
import { normalizeHashtagName } from "@everycal/core";
import type { DB } from "../db.js";
import { verifySignature } from "../lib/crypto.js";
import { ensureKeyPairForAccount } from "../lib/account-keys.js";
import {
  resolveRemoteActor,
  deliverActivity,
  deriveVisibilityFromActivityPubAddressing,
  getAttributedActor,
  normalizeEventVisibility,
  visibilityToActivityPubAddressing,
} from "../lib/federation.js";
import {
  extractApObjectUri,
  isActivityPubRsvpType,
  mapActivityPubRsvpToLocalState,
  normalizeApPublishedWithFallback,
  parseApActorReference,
  resolveLocalRsvpEventTarget,
  upsertRemoteEventRsvp,
} from "../lib/activitypub-rsvp.js";
import { stripHtml } from "../lib/security.js";
import { notifyEventUpdated, notifyEventCancelled } from "../lib/notifications.js";
import { fallbackSlugFromUri } from "../lib/event-links.js";
import { normalizeRemoteEventUri, upsertRemoteEvent } from "../lib/remote-events.js";
import { getLocale, t } from "../lib/i18n.js";
import { enqueueOgJob } from "../lib/og-job-queue.js";
import { normalizeApTemporal } from "../lib/timezone.js";
import { normalizeEventTimezone } from "../lib/event-timezone.js";
import { buildApEventObject, toUtcIsoOrUndefined } from "../lib/activitypub-event.js";
import { buildActorUrl, buildProfileUrl, buildUrl, getBaseUrl } from "../lib/base-url.js";
import { ensureStableActivityId } from "../lib/activity-ids.js";
import { boundedConsoleLog } from "../lib/bounded-log.js";
import { clearRemoteOgImage, generateAndSaveRemoteOgImage, isRemoteActivityOgEligible } from "./og-images.js";

const AP_CONTENT_TYPES = [
  "application/activity+json",
  "application/ld+json",
];

function isAPRequest(accept: string): boolean {
  return AP_CONTENT_TYPES.some((t) => accept.includes(t));
}

/** Convert SQLite datetime to ISO 8601 for ActivityPub (required by spec). */
function toISO8601(dt: string | null | undefined): string | undefined {
  if (!dt) return undefined;
  if (dt.includes("T")) return dt.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dt) ? dt : dt + "Z";
  const normalized = dt.replace(" ", "T");
  return normalized.includes(".") ? normalized + "Z" : normalized + ".000Z";
}

function toEpochMillisOrZero(value: unknown): number {
  const iso = toUtcIsoOrUndefined(value);
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
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

    const keys = ensureKeyPairForAccount(db, account.id as string);
    if (!keys) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
    const baseUrl = getBaseUrl();
    const actorUrl = buildActorUrl(username, baseUrl);

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
      url: buildProfileUrl(username, baseUrl),
      ...(account.created_at ? { published: toISO8601(account.created_at as string) } : {}),
      inbox: buildUrl(actorUrl, "inbox"),
      outbox: buildUrl(actorUrl, "outbox"),
      followers: buildUrl(actorUrl, "followers"),
      following: buildUrl(actorUrl, "following"),
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
        sharedInbox: buildUrl(baseUrl, "inbox"),
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
    const actorUrl = buildActorUrl(username, baseUrl);

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    // Count: owned public events + explicit reposts + auto-reposted events
    const ownedCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM events WHERE account_id = ? AND visibility IN ('public', 'unlisted')"
        )
        .get(account.id) as { cnt: number }
    ).cnt;
    const repostCount = (
      db
        .prepare(
          `SELECT (
             SELECT COUNT(*) FROM reposts r
             JOIN events e ON e.id = r.event_id
             WHERE r.account_id = ? AND e.visibility IN ('public', 'unlisted')
           ) + (
             SELECT COUNT(*) FROM reposts r
             JOIN remote_events re ON re.uri = r.event_uri
             WHERE r.account_id = ? AND re.visibility IN ('public', 'unlisted')
           ) AS cnt`
        )
        .get(account.id, account.id) as { cnt: number }
    ).cnt;
    const autoRepostCount = (
      db
        .prepare(
          `SELECT (
             SELECT COUNT(*) FROM auto_reposts ar
             JOIN events e ON e.account_id = ar.source_account_id
             WHERE ar.account_id = ? AND e.visibility = 'public'
               AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ? AND event_id IS NOT NULL)
           ) + (
             SELECT COUNT(*) FROM auto_reposts ar
             JOIN remote_events re ON re.actor_uri = ar.source_actor_uri
             WHERE ar.account_id = ? AND re.visibility = 'public'
               AND re.uri NOT IN (SELECT event_uri FROM reposts WHERE account_id = ?)
           ) AS cnt`
        )
        .get(account.id, account.id, account.id, account.id) as { cnt: number }
    ).cnt;
    const totalItems = ownedCount + repostCount + autoRepostCount;

    if (!page) {
      return c.json(
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: buildUrl(actorUrl, "outbox"),
          type: "OrderedCollection",
          totalItems,
          first: `${buildUrl(actorUrl, "outbox")}?page=1`,
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
         WHERE e.account_id = ? AND e.visibility IN ('public', 'unlisted')
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
    const repostRemoteRows = db
      .prepare(
        `SELECT r.created_at AS reposted_at, re.uri, re.visibility, re.start_at_utc
         FROM reposts r
         JOIN remote_events re ON re.uri = r.event_uri
         WHERE r.account_id = ? AND re.visibility IN ('public', 'unlisted')`
      )
      .all(account.id) as Record<string, unknown>[];

    const autoRepostRows = db
      .prepare(
        `SELECT ar.created_at AS reposted_at, e.*, GROUP_CONCAT(t.tag) AS tags
         FROM auto_reposts ar
         JOIN events e ON e.account_id = ar.source_account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
          WHERE ar.account_id = ? AND e.visibility = 'public'
            AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ? AND event_id IS NOT NULL)
          GROUP BY e.id`
      )
      .all(account.id, account.id) as Record<string, unknown>[];
    const autoRepostRemoteRows = db
      .prepare(
        `SELECT ar.created_at AS reposted_at, re.uri, re.visibility, re.start_at_utc
         FROM auto_reposts ar
         JOIN remote_events re ON re.actor_uri = ar.source_actor_uri
         WHERE ar.account_id = ? AND re.visibility = 'public'
           AND re.uri NOT IN (SELECT event_uri FROM reposts WHERE account_id = ?)`
      )
      .all(account.id, account.id) as Record<string, unknown>[];

    const eventUrl = (id: string) => buildUrl(baseUrl, "events", id);
    const createItems = ownedRows.map((row) => ({
      id: buildUrl(baseUrl, "events", row.id as string, "activity"),
      type: "Create",
      actor: actorUrl,
      published: toISO8601(row.created_at as string) ?? row.created_at,
      ...visibilityToActivityPubAddressing(normalizeEventVisibility(row.visibility as string), actorUrl),
      object: rowToAPEvent(row, actorUrl, baseUrl),
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));

    const repostAnnounceItems = repostRows.map((row) => ({
      id: ensureStableActivityId(db, {
        actorUri: actorUrl,
        activityType: "Announce",
        objectUri: eventUrl(row.id as string),
        logicalKey: `announce:${account.id}:${eventUrl(row.id as string)}`,
      }),
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      ...visibilityToActivityPubAddressing(normalizeEventVisibility(row.visibility as string), actorUrl),
      object: eventUrl(row.id as string),
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));
    const autoRepostAnnounceItems = autoRepostRows.map((row) => ({
      id: ensureStableActivityId(db, {
        actorUri: actorUrl,
        activityType: "Announce",
        objectUri: eventUrl(row.id as string),
        logicalKey: `announce:${account.id}:${eventUrl(row.id as string)}`,
      }),
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      ...visibilityToActivityPubAddressing(normalizeEventVisibility(row.visibility as string), actorUrl),
      object: eventUrl(row.id as string),
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));
    const repostRemoteAnnounceItems = repostRemoteRows.map((row) => ({
      id: ensureStableActivityId(db, {
        actorUri: actorUrl,
        activityType: "Announce",
        objectUri: row.uri as string,
        logicalKey: `announce:${account.id}:${String(row.uri)}`,
      }),
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      ...visibilityToActivityPubAddressing(normalizeEventVisibility(row.visibility as string), actorUrl),
      object: row.uri,
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));
    const autoRepostRemoteAnnounceItems = autoRepostRemoteRows.map((row) => ({
      id: ensureStableActivityId(db, {
        actorUri: actorUrl,
        activityType: "Announce",
        objectUri: row.uri as string,
        logicalKey: `announce:${account.id}:${String(row.uri)}`,
      }),
      type: "Announce",
      actor: actorUrl,
      published: toISO8601(row.reposted_at as string) ?? row.reposted_at,
      ...visibilityToActivityPubAddressing(normalizeEventVisibility(row.visibility as string), actorUrl),
      object: row.uri,
      _sortMs: toEpochMillisOrZero(row.start_at_utc),
    }));

    // Merge and sort by event start date (desc = newest first)
    const allItems = [...createItems, ...repostAnnounceItems, ...autoRepostAnnounceItems, ...repostRemoteAnnounceItems, ...autoRepostRemoteAnnounceItems].sort(
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
      id: `${buildUrl(actorUrl, "outbox")}?page=${pageNum}`,
      type: "OrderedCollectionPage",
      partOf: buildUrl(actorUrl, "outbox"),
      orderedItems,
    };

    if (pageItems.length === limit) {
      result.next = `${buildUrl(actorUrl, "outbox")}?page=${pageNum + 1}`;
    }

    return c.json(result, 200, {
      "Content-Type": "application/activity+json; charset=utf-8",
    });
  });

  // ---- Followers Collection ----
  router.get("/:username/followers", (c) => {
    const username = c.req.param("username");
    const baseUrl = getBaseUrl();
    const actorUrl = buildActorUrl(username, baseUrl);

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
        id: buildUrl(actorUrl, "followers"),
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
    const actorUrl = buildActorUrl(username, baseUrl);

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
        id: buildUrl(actorUrl, "following"),
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
    const actorUri = parseInboxActorUri(activity);
    if (!actorUri) {
      return c.json({ error: t(getLocale(c), "common.invalid_request") }, 400);
    }

    // Verify the incoming activity has a valid HTTP Signature
    // SKIP_SIGNATURE_VERIFY is only allowed in non-production environments
    const skipVerify = process.env.SKIP_SIGNATURE_VERIFY === "true" && process.env.NODE_ENV !== "production";
    if (!skipVerify) {
      const verified = await verifyInboxSignature(db, c, actorUri, rawBody);
      if (!verified) {
        console.log(`  ⚠️  Signature verification failed for ${actorUri}`);
        return c.json({ error: t(getLocale(c), "common.invalid_signature") }, 401);
      }
    }

    const targetContext = inboxTargetContext("user", username);
    const claimedInboxActivity = claimInboxActivityProcessing(db, activity, actorUri, targetContext);
    if (!claimedInboxActivity) {
      console.log(`  ⏭ Skipping duplicate inbox activity ${activity.id}`);
      return c.json({ ok: true, duplicate: true }, 202);
    }

    console.log(`📬 Inbox for ${username}: ${type} from ${actorUri}`);

    try {
      switch (type) {
        case "Follow":
          await handleFollow(db, account, activity, actorUri);
          break;
        case "Undo":
          await handleUndo(db, account, activity, actorUri);
          break;
        case "Create":
        case "Update":
          handleCreateUpdate(db, activity, type, actorUri);
          break;
        case "Delete":
          handleDelete(db, activity, actorUri);
          break;
        case "Accept":
        case "TentativeAccept":
        case "Reject":
        case "Join":
        case "Leave":
          handleRsvpActivity(db, activity, actorUri, { inboxUsername: username });
          break;
        default:
          if (logUnknownRsvpVerbIfApplicable(db, activity, actorUri, "user-inbox")) break;
          console.log(`  ⏭ Ignored activity type: ${type}`);
      }
    } catch (error) {
      markInboxActivityFailed(db, activity, actorUri, targetContext, error);
      throw error;
    }

    markInboxActivityProcessed(db, activity, actorUri, targetContext);

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
    const actorUri = parseInboxActorUri(activity);
    if (!actorUri) {
      return c.json({ error: t(getLocale(c), "common.invalid_request") }, 400);
    }

    // Verify HTTP Signature
    const skipVerify = process.env.SKIP_SIGNATURE_VERIFY === "true" && process.env.NODE_ENV !== "production";
    if (!skipVerify) {
      const verified = await verifyInboxSignature(db, c, actorUri, rawBody);
      if (!verified) {
        console.log(`  ⚠️  Shared inbox signature verification failed for ${actorUri}`);
        return c.json({ error: t(getLocale(c), "common.invalid_signature") }, 401);
      }
    }

    const targetContext = inboxTargetContext("shared", "inbox");
    const claimedInboxActivity = claimInboxActivityProcessing(db, activity, actorUri, targetContext);
    if (!claimedInboxActivity) {
      console.log(`  ⏭ Skipping duplicate shared inbox activity ${activity.id}`);
      return c.json({ ok: true, duplicate: true }, 202);
    }

    console.log(`📬 Shared inbox: ${type} from ${actorUri}`);

    try {
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
            if (account) await handleFollow(db, account, activity, actorUri);
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
              if (account) await handleUndo(db, account, activity, actorUri);
            }
          }
          break;
        }
        case "Create":
        case "Update":
          handleCreateUpdate(db, activity, type, actorUri);
          break;
        case "Delete":
          handleDelete(db, activity, actorUri);
          break;
        case "Accept":
        case "TentativeAccept":
        case "Reject":
        case "Join":
        case "Leave":
          handleRsvpActivity(db, activity, actorUri);
          break;
        default:
          if (logUnknownRsvpVerbIfApplicable(db, activity, actorUri, "shared-inbox")) break;
      }
    } catch (error) {
      markInboxActivityFailed(db, activity, actorUri, targetContext, error);
      throw error;
    }

    markInboxActivityProcessed(db, activity, actorUri, targetContext);

    return c.json({ ok: true }, 202);
  });

  return router;
}

function inboxTargetContext(kind: "user" | "shared", target: string): string {
  return `${kind}:${target}`;
}

function parseActorUri(actor: unknown): string | null {
  return parseApActorReference(actor);
}

function parseInboxActorUri(activity: Record<string, unknown>): string | null {
  return parseActorUri(activity.actor);
}

function logUnknownRsvpVerbIfApplicable(
  db: DB,
  activity: Record<string, unknown>,
  actorUri: string,
  source: "user-inbox" | "shared-inbox",
): boolean {
  const type = activity.type;
  if (typeof type !== "string" || isActivityPubRsvpType(type)) return false;
  const target = resolveLocalRsvpEventTarget(db, activity);
  if (!target) return false;

  boundedConsoleLog(
    `unknown-rsvp:${source}:${type}:${actorUri}`,
    `  ⏭ Ignored unknown RSVP activity type: ${type} from ${actorUri} for ${target.eventId}`,
    { level: "warn" },
  );
  return true;
}

function parseActivityId(activityId: unknown): string | null {
  if (typeof activityId !== "string") return null;
  const trimmed = activityId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const INBOX_PROCESSING_CLAIM_TTL_MINUTES = 5;

function claimInboxActivityProcessing(db: DB, activity: Record<string, unknown>, actorUri: string, targetContext: string): boolean {
  const activityId = parseActivityId(activity.id);
  if (!activityId) {
    console.warn("  ⚠️  Inbox activity has no stable id; processing without replay dedupe");
    return true;
  }

  const staleThreshold = `-${INBOX_PROCESSING_CLAIM_TTL_MINUTES} minutes`;
  const result = db.prepare(
    `INSERT INTO processed_inbox_activities (
      activity_id,
      actor_uri,
      target_context,
      status,
      claimed_at,
      processed_at,
      last_error,
      received_at
    ) VALUES (?, ?, ?, 'processing', datetime('now'), NULL, NULL, datetime('now'))
    ON CONFLICT(activity_id, actor_uri, target_context) DO UPDATE SET
      status = 'processing',
      claimed_at = datetime('now'),
      last_error = NULL
    WHERE processed_inbox_activities.status != 'processed'
      AND (
        processed_inbox_activities.status = 'failed'
        OR processed_inbox_activities.claimed_at IS NULL
        OR processed_inbox_activities.claimed_at <= datetime('now', ?)
      )`
  ).run(activityId, actorUri, targetContext, staleThreshold);
  return result.changes === 1;
}

function markInboxActivityProcessed(db: DB, activity: Record<string, unknown>, actorUri: string, targetContext: string): void {
  const activityId = parseActivityId(activity.id);
  if (!activityId) return;
  db.prepare(
    `UPDATE processed_inbox_activities
     SET status = 'processed', claimed_at = NULL, processed_at = datetime('now'), last_error = NULL
     WHERE activity_id = ? AND actor_uri = ? AND target_context = ?`
  ).run(activityId, actorUri, targetContext);
}

function markInboxActivityFailed(
  db: DB,
  activity: Record<string, unknown>,
  actorUri: string,
  targetContext: string,
  error: unknown
): void {
  const activityId = parseActivityId(activity.id);
  if (!activityId) return;
  const errorMessage = error instanceof Error ? error.message : String(error);
  db.prepare(
    `UPDATE processed_inbox_activities
     SET status = 'failed', claimed_at = NULL, last_error = ?
     WHERE activity_id = ? AND actor_uri = ? AND target_context = ?`
  ).run(errorMessage, activityId, actorUri, targetContext);
}

// ---- Activity Handlers ----

async function handleFollow(
  db: DB,
  account: { id: string; username: string },
  activity: Record<string, unknown>,
  actorUri: string
) {
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
  if (!keys) return;
  const baseUrl = getBaseUrl();
  const actorUrl = buildActorUrl(account.username, baseUrl);

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
  activity: Record<string, unknown>,
  actorUri: string
) {
  const inner = activity.object as Record<string, unknown>;
  if (!inner || inner.type !== "Follow") return;
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

function handleCreateUpdate(db: DB, activity: Record<string, unknown>, activityType: string, actorUri: string) {
  const object = activity.object as Record<string, unknown>;
  if (!object || object.type !== "Event") return;

  // Validate that actor matches attributedTo (prevent impersonation)
  const attributedTo = getAttributedActor(object);

  if (attributedTo.status === "unparseable") {
    console.log("  ⚠️  Rejecting Create/Update: attributedTo is present but unparseable");
    return;
  }

  // If attributedTo is present, it must match the activity actor
  if (attributedTo.status === "parsed" && attributedTo.actor !== actorUri) {
    console.log(`  ⚠️  Rejecting Create/Update: actor ${actorUri} != attributedTo ${attributedTo.actor}`);
    return;
  }

  const effectiveActor = attributedTo.status === "parsed" ? attributedTo.actor : actorUri;
  const actorFollowersUrl = (db
    .prepare("SELECT followers_url FROM remote_actors WHERE uri = ?")
    .get(effectiveActor) as { followers_url: string | null } | undefined)?.followers_url ?? null;
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

  const uri = normalizeRemoteEventUri(object.id);
  if (!uri) {
    console.log(`  ⚠️  Skipping ${activityType}: Event object.id is missing or not a non-empty string`);
    return;
  }
  const owner = db.prepare("SELECT actor_uri FROM remote_events WHERE uri = ?").get(uri) as { actor_uri: string } | undefined;
  if (owner && owner.actor_uri !== effectiveActor) {
    console.log(`  ⚠️  Rejecting Create/Update: actor ${effectiveActor} doesn't own existing event ${uri} (owner: ${owner.actor_uri})`);
    return;
  }

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


  const upserted = upsertRemoteEvent(db, object, effectiveActor, {
    clearCanceled: true,
    temporal,
    actorFollowersUrl,
    visibility:
      ("to" in activity || "cc" in activity)
        ? deriveVisibilityFromActivityPubAddressing(activity, {
          actorFollowersUrl,
        })
        : undefined,
  });

  if (isRemoteActivityOgEligible(activity, object)) {
    enqueueOgJob(`remote:${upserted.uri}`, async () => {
      try {
        await generateAndSaveRemoteOgImage(db, upserted.uri);
      } catch (err) {
        console.error(`[OG] Failed to create remote OG image for event ${upserted.uri}:`, err);
      }
    });
  } else {
    enqueueOgJob(`remote:${upserted.uri}`, async () => {
      try {
        await clearRemoteOgImage(db, upserted.uri);
      } catch (err) {
        console.error(`[OG] Failed to clear remote OG image for event ${upserted.uri}:`, err);
      }
    });
  }

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


function resolveLocalRsvpEvent(
  db: DB,
  activity: Record<string, unknown>,
  options: { inboxUsername?: string } = {},
): { eventId: string; ownerActorUri: string } | null {
  const target = resolveLocalRsvpEventTarget(db, activity, options);
  if (!target) {
    console.log("  ⚠️  Rejecting RSVP: invalid local Event target");
    return null;
  }
  return target;
}

function handleRsvpActivity(
  db: DB,
  activity: Record<string, unknown>,
  actorUri: string,
  options: { inboxUsername?: string } = {},
): void {
  const activityType = activity.type;
  if (!isActivityPubRsvpType(activityType)) {
    console.log(`  ⏭ Ignored non-RSVP activity type: ${String(activityType)}`);
    return;
  }

  const localState = mapActivityPubRsvpToLocalState(activityType);
  const target = resolveLocalRsvpEvent(db, activity, options);
  if (!target) return;

  const result = upsertRemoteEventRsvp(db, {
    eventId: target.eventId,
    actorUri,
    activityType,
    activityId: parseActivityId(activity.id),
    publishedAt: normalizeApPublishedWithFallback(activity.published, activity.updated),
    localState,
  });

  if (result.applied) {
    console.log(`  ✅ Stored remote RSVP ${activityType} from ${actorUri} for ${target.eventId} as ${result.status}`);
  } else {
    console.log(`  ⏭ Ignored stale remote RSVP ${activityType} from ${actorUri} for ${target.eventId}`);
  }
}

function handleDelete(db: DB, activity: Record<string, unknown>, actorUri: string) {
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

// ---- Helpers ----

/** Extract URI from ActivityPub object (string IRI or object with id). */
function extractObjectUri(obj: unknown): string | undefined {
  return extractApObjectUri(obj);
}

function rowToAPEvent(
  row: Record<string, unknown>,
  actorUrl: string,
  baseUrl: string
): Record<string, unknown> {
  const eventUrl = buildUrl(baseUrl, "events", row.id as string);
  const tags = row.tags ? (row.tags as string).split(",") : [];
  const isAllDay = !!row.all_day;
  const { to, cc } = visibilityToActivityPubAddressing(
    normalizeEventVisibility(row.visibility as string),
    actorUrl,
  );
  const event = buildApEventObject({
    id: eventUrl,
    name: row.title as string,
    attributedTo: actorUrl,
    to,
    cc,
    allDay: isAllDay,
    startDate: row.start_date,
    endDate: row.end_date,
    startAtUtc: row.start_at_utc,
    endAtUtc: row.end_at_utc,
    content: row.description as string | undefined,
    published: toISO8601(row.created_at as string) ?? (row.created_at as string | undefined),
    updated: toISO8601(row.updated_at as string) ?? (row.updated_at as string | undefined),
    url: (row.url as string) || eventUrl,
    eventTimezone: normalizeEventTimezone(row.event_timezone),
    includeContext: true,
  });

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
    const normalizedTags = tags
      .map(normalizeHashtagName)
      .filter((t): t is string => Boolean(t));
    if (normalizedTags.length > 0) {
      event.tag = normalizedTags.map((t) => ({
        type: "Hashtag",
        name: `#${t}`,
      }));
    }
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
         WHERE e.id = ? AND e.visibility IN ('public', 'unlisted')
         GROUP BY e.id`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    const baseUrl = getBaseUrl();
    const actorUrl = buildActorUrl(row.username as string, baseUrl);
    const event = rowToAPEvent(row, actorUrl, baseUrl);

    return c.json(event, 200, {
      "Content-Type": "application/activity+json; charset=utf-8",
    });
  });

  return router;
}
