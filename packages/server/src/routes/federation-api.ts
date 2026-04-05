/**
 * Federation API routes — search/follow remote actors, view remote events.
 *
 * GET  /api/v1/federation/search?q=user@domain   — Resolve a remote actor via WebFinger
 * POST /api/v1/federation/follow                  — Follow a remote actor
 * POST /api/v1/federation/unfollow                — Unfollow a remote actor
 * GET  /api/v1/federation/remote-events           — List fetched remote events
 * POST /api/v1/federation/fetch-actor             — Fetch/refresh a remote actor and their events
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  formatRemoteActorAccount,
  formatRemoteActorIdentity,
  fetchAP,
  resolveRemoteActor,
  fetchRemoteOutbox,
  deliverActivity,
  discoverDomainActors,
  validateFederationUrl,
} from "../lib/federation.js";
import { generateKeyPair } from "../lib/crypto.js";
import { getLocale, t } from "../lib/i18n.js";
import { listActingAccounts } from "../lib/identities.js";
import { upsertRemoteEvent } from "../lib/remote-events.js";
import { normalizeApTemporal } from "../lib/timezone.js";
import { DateQueryParamError, normalizeDateRangeParams } from "../lib/date-query.js";
import {
  ActorSelectionPayloadError,
  buildActorSelectionPlan,
  isDesiredAccountIdsAllowed,
  readActorSelectionPayload,
  summarizeActorSelection,
  type ActorSelectionResult,
} from "../lib/actor-selection.js";

function createFollowActivityId(actorUrl: string): string {
  return `${actorUrl}#follows/${Date.now()}-${nanoid(10)}`;
}

function buildFollowActivity(actorUrl: string, actorUri: string): { id: string; type: string; actor: string; object: string; "@context": string } {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: createFollowActivityId(actorUrl),
    type: "Follow",
    actor: actorUrl,
    object: actorUri,
  };
}

function buildUndoFollowActivity(actorUrl: string, actorUri: string, followActivityId?: string | null): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actorUrl}#undo-follow-${Date.now()}`,
    type: "Undo",
    actor: actorUrl,
    object: followActivityId || {
      type: "Follow",
      actor: actorUrl,
      object: actorUri,
    },
  };
}

export function federationRoutes(db: DB): Hono {
  const router = new Hono();

  // Search for a remote actor via WebFinger (auth required to prevent SSRF)
  router.get("/search", requireAuth(), async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ error: t(getLocale(c), "federation.q_required") }, 400);

    // Parse user@domain or @user@domain or full URL
    let actorUri: string | null = null;

    if (q.startsWith("https://") || q.startsWith("http://")) {
      actorUri = q;
    } else {
      const match = q.match(/^@?([^@]+)@([^@]+)$/);
      if (!match) {
        return c.json({ error: t(getLocale(c), "federation.invalid_format") }, 400);
      }
      const [, username, domain] = match;

      // WebFinger lookup
      try {
        const wfUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;
        await validateFederationUrl(wfUrl);
        const res = await fetch(wfUrl, {
          headers: { Accept: "application/jrd+json" },
          redirect: "error",
        });
        if (!res.ok) {
          return c.json({ error: t(getLocale(c), "federation.webfinger_lookup_failed_status", { status: String(res.status) }) }, 404);
        }
        const wf = (await res.json()) as {
          links: Array<{ rel: string; type?: string; href?: string }>;
        };
        const self = wf.links?.find(
          (l) => l.rel === "self" && l.type === "application/activity+json"
        );
        if (!self?.href) {
          return c.json({ error: t(getLocale(c), "federation.no_actor_found") }, 404);
        }
        await validateFederationUrl(self.href);
        actorUri = self.href;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const msgLower = msg.toLowerCase();
        if (
          msgLower.includes("private/internal") ||
          msgLower.includes("resolves to private") ||
          msgLower.includes("invalid protocol") ||
          msgLower.includes("only https")
        ) {
          return c.json({ error: t(getLocale(c), "federation.private_address_not_allowed") }, 400);
        }
        return c.json({ error: t(getLocale(c), "federation.webfinger_lookup_failed_error", { error: msg }) }, 502);
      }
    }

    // Fetch the actor
    const actor = await resolveRemoteActor(db, actorUri, true);
    if (!actor) {
      return c.json({ error: t(getLocale(c), "federation.could_not_resolve_actor") }, 404);
    }

    // Trigger domain discovery in background (fetch full profile list from server)
    discoverDomainActors(db, actor.domain, { minAgeHours: 24 }).catch(() => {});

    const eventsCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM remote_events WHERE actor_uri = ?")
      .get(actor.uri) as { cnt: number };
    const eventsCountVal = eventsCount?.cnt ?? 0;

    return c.json({
      actor: {
        uri: actor.uri,
        type: actor.type,
        username: actor.preferred_username,
        displayName: actor.display_name,
        summary: actor.summary,
        domain: actor.domain,
        iconUrl: actor.icon_url,
        imageUrl: actor.image_url,
        outbox: actor.outbox,
        eventsCount: eventsCountVal,
        followersCount: actor.followers_count ?? 0,
        followingCount: actor.following_count ?? 0,
      },
    });
  });

  // Fetch a remote actor's events (auth required to prevent SSRF abuse)
  router.post("/fetch-actor", requireAuth(), async (c) => {
    const { actorUri } = await c.req.json<{ actorUri: string }>();
    if (!actorUri) return c.json({ error: t(getLocale(c), "federation.actor_uri_required") }, 400);

    const actor = await resolveRemoteActor(db, actorUri, true);
    if (!actor || !actor.outbox) {
      return c.json({ error: t(getLocale(c), "federation.could_not_resolve_actor_outbox") }, 404);
    }

    try {
      const items = await fetchRemoteOutbox(actor.outbox);
      let imported = 0;

      for (const item of items) {
        // Outbox items may be full activities or URL references — resolve if needed
        let activity = item as Record<string, unknown>;
        if (typeof item === "string") {
          try {
            activity = (await fetchAP(item)) as Record<string, unknown>;
          } catch (err) {
            console.warn(`Failed to fetch outbox item ${item}:`, err);
            continue;
          }
        }

        const activityType = activity.type as string;

        // Create = actor created the event; Announce = actor reposted/boosted the event
        if (activityType !== "Create" && activityType !== "Announce") continue;

        let object = activity.object;
        if (!object) continue;

        // Object may be a URL (reference) or minimal {id, type} — fetch full object if needed
        if (typeof object === "string") {
          try {
            object = await fetchAP(object);
          } catch (err) {
            console.warn(`Failed to fetch event object ${object}:`, err);
            continue;
          }
        }

        const obj = object as Record<string, unknown>;
        if (obj.type !== "Event") continue;

        // If object is a minimal reference (has id but missing name/startTime), fetch full object
        if (obj.id && !obj.name && !obj.title && !obj.startTime && !obj.startDate) {
          try {
            object = await fetchAP(obj.id as string);
          } catch (err) {
            console.warn(`Failed to fetch event ${obj.id}:`, err);
            continue;
          }
        }

        const fullObj = object as Record<string, unknown>;
        const title = fullObj.name ?? fullObj.title;
        const startTime = fullObj.startTime ?? fullObj.startDate;
        if (!title || !startTime) continue;

        const temporal = normalizeApTemporal(fullObj);
        if (!temporal) continue;
        upsertRemoteEvent(db, fullObj, actor.uri, { temporal });
        imported++;
      }

      return c.json({ ok: true, imported, total: items.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: t(getLocale(c), "federation.failed_to_fetch_outbox", { error: msg }) }, 502);
    }
  });

  // Follow a remote actor
  router.post("/follow", requireAuth(), async (c) => {
    const user = c.get("user")!;
    let actorUri: string | undefined;
    let desiredAccountIds: string[] | undefined;
    try {
      ({ actorUri, desiredAccountIds } = await readActorSelectionPayload(c));
    } catch (err) {
      if (err instanceof ActorSelectionPayloadError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
    if (!actorUri) return c.json({ error: t(getLocale(c), "federation.actor_uri_required") }, 400);

    const actor = await resolveRemoteActor(db, actorUri);
    if (!actor) return c.json({ error: t(getLocale(c), "federation.could_not_resolve_actor") }, 404);

    if (!desiredAccountIds) {
      // Ensure our account has keys
      const account = db
        .prepare("SELECT id, username, private_key, public_key FROM accounts WHERE id = ?")
        .get(user.id) as Record<string, unknown>;

      let privateKey = account.private_key as string;
      if (!privateKey) {
        const keys = generateKeyPair();
        db.prepare("UPDATE accounts SET public_key = ?, private_key = ? WHERE id = ?").run(
          keys.publicKey,
          keys.privateKey,
          user.id
        );
        privateKey = keys.privateKey;
      }

      const baseUrl = process.env.BASE_URL || "http://localhost:3000";
      const ourActorUrl = `${baseUrl}/users/${user.username}`;

      const followActivity = buildFollowActivity(ourActorUrl, actorUri);

      const delivered = await deliverActivity(
        actor.inbox,
        followActivity,
        privateKey,
        `${ourActorUrl}#main-key`
      );

      if (delivered) {
        db.prepare(
          `INSERT OR REPLACE INTO remote_following (account_id, actor_uri, actor_inbox, follow_activity_id, follow_object_uri)
           VALUES (?, ?, ?, ?, ?)`
        ).run(user.id, actorUri, actor.inbox, followActivity.id, followActivity.id);
      }

      return c.json({ ok: true, delivered });
    }

    const acting = listActingAccounts(db, user.id, "editor");
    const actingIds = acting.map((a) => a.id);
    if (!isDesiredAccountIdsAllowed(desiredAccountIds, actingIds)) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const activeRows = db
      .prepare("SELECT account_id, follow_activity_id FROM remote_following WHERE actor_uri = ?")
      .all(actorUri) as Array<{ account_id: string; follow_activity_id: string | null }>;
    const plan = buildActorSelectionPlan({
      actingAccountIds: actingIds,
      desiredAccountIds,
      activeAccountIds: activeRows.map((r) => r.account_id),
    });
    const followRefs = new Map(activeRows.map((row) => [row.account_id, row.follow_activity_id]));
    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    const operationId = createHash("sha256")
      .update(`${Date.now()}-${user.id}-${actorUri}-${Math.random()}`)
      .digest("hex")
      .slice(0, 16);

    db.prepare(
      `INSERT INTO actor_selection_operations
       (id, action_kind, target_type, target_id, initiated_by_account_id, status)
       VALUES (?, 'remote_follow', 'remote_actor', ?, ?, 'pending')`
    ).run(operationId, actorUri, user.id);

    const results: ActorSelectionResult[] = [];
    for (const entry of plan.entries) {
      const accountId = entry.accountId;
      const before = entry.before;
      const after = entry.after;
      if (before === after) {
        results.push({ accountId, before, after, status: "unchanged", remoteStatus: "none" });
        continue;
      }

      const accountKeys = db
        .prepare("SELECT username, private_key, public_key FROM accounts WHERE id = ?")
        .get(accountId) as { username: string; private_key: string | null; public_key: string | null };

      let privateKey = accountKeys.private_key;
      if (!privateKey) {
        const keys = generateKeyPair();
        db.prepare("UPDATE accounts SET public_key = ?, private_key = ? WHERE id = ?").run(
          keys.publicKey,
          keys.privateKey,
          accountId
        );
        privateKey = keys.privateKey;
      }

      const actorUrl = `${baseUrl}/users/${accountKeys.username}`;

      try {
        if (after) {
          const followActivity = buildFollowActivity(actorUrl, actorUri);
          const delivered = await deliverActivity(actor.inbox, followActivity, privateKey, `${actorUrl}#main-key`);
          if (delivered) {
            db.prepare(
              `INSERT OR REPLACE INTO remote_following (account_id, actor_uri, actor_inbox, follow_activity_id, follow_object_uri)
               VALUES (?, ?, ?, ?, ?)`
            ).run(accountId, actorUri, actor.inbox, followActivity.id, followActivity.id);
            results.push({ accountId, before, after: true, status: "added", remoteStatus: "delivered" });
          } else {
            results.push({ accountId, before, after: before, status: "error", message: t(getLocale(c), "common.requestFailed"), remoteStatus: "failed" });
          }
        } else {
          const followActivityId = followRefs.get(accountId) || null;
          const undoActivity = buildUndoFollowActivity(actorUrl, actorUri, followActivityId);
          const delivered = await deliverActivity(actor.inbox, undoActivity, privateKey, `${actorUrl}#main-key`);
          db.prepare("DELETE FROM remote_following WHERE account_id = ? AND actor_uri = ?").run(accountId, actorUri);
          results.push({
            accountId,
            before,
            after: false,
            status: "removed",
            remoteStatus: delivered ? "delivered" : "failed",
            ...(delivered ? {} : { message: "Undo delivery failed remotely; removed locally" }),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t(getLocale(c), "common.requestFailed");
        results.push({ accountId, before, after: before, status: "error", message, remoteStatus: "failed" });
      }
    }

    db.transaction(() => {
      const insertItem = db.prepare(
        `INSERT INTO actor_selection_operation_items
         (operation_id, account_id, before_state, after_state, status, remote_status, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of results) {
        insertItem.run(
          operationId,
          row.accountId,
          row.before ? 1 : 0,
          row.after ? 1 : 0,
          row.status,
          row.remoteStatus || "none",
          row.message || null
        );
      }
      db.prepare("UPDATE actor_selection_operations SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(operationId);
    })();

    const summary = summarizeActorSelection(results);

    return c.json({
      ok: true,
      operationId,
      added: summary.added,
      removed: summary.removed,
      unchanged: summary.unchanged,
      failed: summary.failed,
      results,
    });
  });

  router.get("/follow-actors", requireAuth(), (c) => {
    const user = c.get("user")!;
    const actorUri = c.req.query("actorUri") || "";
    if (!actorUri) return c.json({ error: t(getLocale(c), "federation.actor_uri_required") }, 400);

    const acting = listActingAccounts(db, user.id, "editor");
    const allowed = new Set(acting.map((a) => a.id));
    const activeRows = db
      .prepare("SELECT account_id FROM remote_following WHERE actor_uri = ?")
      .all(actorUri) as Array<{ account_id: string }>;
    const activeAccountIds = activeRows.map((r) => r.account_id).filter((id) => allowed.has(id));
    return c.json({ activeAccountIds, actorIds: Array.from(allowed) });
  });

  // Unfollow a remote actor
  router.post("/unfollow", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const { actorUri } = await c.req.json<{ actorUri: string }>();
    if (!actorUri) return c.json({ error: t(getLocale(c), "federation.actor_uri_required") }, 400);

    const actor = await resolveRemoteActor(db, actorUri);
    if (!actor) return c.json({ error: t(getLocale(c), "federation.could_not_resolve_actor") }, 404);

    const account = db
      .prepare("SELECT username, private_key FROM accounts WHERE id = ?")
      .get(user.id) as { username: string; private_key: string | null };
    const followRow = db
      .prepare("SELECT follow_activity_id FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get(user.id, actorUri) as { follow_activity_id: string | null } | undefined;

    let delivered = false;
    if (account.private_key) {
      const baseUrl = process.env.BASE_URL || "http://localhost:3000";
      const ourActorUrl = `${baseUrl}/users/${account.username}`;

      const undoActivity = buildUndoFollowActivity(ourActorUrl, actorUri, followRow?.follow_activity_id);

      delivered = await deliverActivity(
        actor.inbox,
        undoActivity,
        account.private_key,
        `${ourActorUrl}#main-key`
      );
    }

    db.prepare("DELETE FROM remote_following WHERE account_id = ? AND actor_uri = ?").run(
      user.id,
      actorUri
    );

    return c.json({ ok: true, delivered });
  });

  // List remote events
  router.get("/remote-events", (c) => {
    const actorUri = c.req.query("actor");
    const fromRaw = c.req.query("from");
    let from: string | undefined;
    try {
      ({ from } = normalizeDateRangeParams(fromRaw));
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let sql = `
      SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
             ra.domain, ra.icon_url AS actor_icon_url, ra.fetch_status AS actor_fetch_status
      FROM remote_events re
      LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (actorUri) {
      sql += " AND re.actor_uri = ?";
      params.push(actorUri);
    }
    if (from) {
      sql += " AND re.start_at_utc >= ?";
      params.push(from);
    }

    sql += " ORDER BY re.start_at_utc ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return c.json({
      events: rows.map((row) => ({
        id: row.uri,
        uri: row.uri,
        slug: row.slug,
        source: "remote",
        actorUri: row.actor_uri,
        account: formatRemoteActorAccount({
          status: row.actor_fetch_status as string | null,
          preferredUsername: row.preferred_username as string | null,
          displayName: row.actor_display_name as string | null,
          domain: row.domain as string | null,
          iconUrl: row.actor_icon_url as string | null,
        }),
        title: row.title,
        description: row.description,
        startDate: row.start_date,
        endDate: row.end_date,
        startAtUtc: row.start_at_utc,
        endAtUtc: row.end_at_utc,
        eventTimezone: row.event_timezone,
        timezoneQuality: row.timezone_quality as "exact_tzid" | "offset_only",
        allDay: !!row.all_day,
        location: row.location_name
          ? {
              name: row.location_name,
              address: row.location_address,
              latitude: row.location_latitude,
              longitude: row.location_longitude,
            }
          : null,
        image: row.image_url
          ? { url: row.image_url, mediaType: row.image_media_type, alt: row.image_alt }
          : null,
        url: row.url,
        tags: row.tags ? (row.tags as string).split(",") : [],
        visibility: "public",
        canceled: !!row.canceled,
        createdAt: row.published,
        updatedAt: row.updated,
      })),
    });
  });

  // List remote actors the current user follows
  router.get("/following", requireAuth(), (c) => {
    const user = c.get("user")!;
    const rows = db
      .prepare(
        `SELECT ra.*
         FROM remote_following rf
         JOIN remote_actors ra ON ra.uri = rf.actor_uri
         WHERE rf.account_id = ?
         ORDER BY rf.created_at DESC`
      )
      .all(user.id) as Record<string, unknown>[];

    return c.json({
      actors: rows.map((r) => {
        const actorIdentity = formatRemoteActorIdentity({
          status: r.fetch_status as string | null,
          preferredUsername: r.preferred_username as string | null,
          displayName: r.display_name as string | null,
          summary: r.summary as string | null,
          iconUrl: r.icon_url as string | null,
          imageUrl: r.image_url as string | null,
        });
        return {
          uri: r.uri,
          type: r.type,
          username: actorIdentity.username,
          displayName: actorIdentity.displayName,
          summary: actorIdentity.summary,
          domain: r.domain,
          iconUrl: actorIdentity.iconUrl,
          imageUrl: actorIdentity.imageUrl,
          outbox: r.outbox,
          followersCount: r.followers_count ?? 0,
          followingCount: r.following_count ?? 0,
        };
      }),
    });
  });

  // Refresh stale remote actor data (auth required — triggers outbound requests)
  // Also discovers new profiles from domains that support directory API
  router.post("/refresh-actors", requireAuth(), async (c) => {
    const maxRefresh = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
    const maxAgeHours = parseInt(c.req.query("maxAgeHours") || "24", 10);
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const nowIso = new Date().toISOString();

    const stale = db
      .prepare(
        `SELECT uri
         FROM remote_actors
         WHERE last_fetched_at < ?
           AND COALESCE(fetch_status, 'active') != 'gone'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY last_fetched_at ASC
         LIMIT ?`
      )
      .all(cutoff, nowIso, maxRefresh) as { uri: string }[];

    let refreshed = 0;
    const concurrency = 3;
    for (let i = 0; i < stale.length; i += concurrency) {
      const batch = stale.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((r) => resolveRemoteActor(db, r.uri, true))
      );
      refreshed += results.filter(Boolean).length;
    }

    // Discover profiles from domains we're connected to (Mastodon/Pleroma directory)
    const domains = db
      .prepare(
        `SELECT DISTINCT domain FROM remote_actors
         WHERE domain NOT IN (SELECT domain FROM domain_discovery WHERE last_discovered_at > ?)
         LIMIT 5`
      )
      .all(cutoff) as { domain: string }[];

    let discovered = 0;
    for (const { domain } of domains) {
      const r = await discoverDomainActors(db, domain, {
        minAgeHours: 24,
        maxAccounts: 200,
      });
      discovered += r.discovered;
    }

    return c.json({ refreshed, discovered });
  });

  // List remote actors we know about
  router.get("/actors", (c) => {
    const domain = c.req.query("domain");
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let sql =
      `SELECT ra.*, (SELECT COUNT(*) FROM remote_events WHERE actor_uri = ra.uri) AS events_count
       FROM remote_actors ra WHERE 1=1`;
    const params: unknown[] = [];

    if (domain) {
      sql += " AND ra.domain = ?";
      params.push(domain);
    }

    sql += " ORDER BY ra.last_fetched_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return c.json({
      actors: rows.map((r) => {
        const actorIdentity = formatRemoteActorIdentity({
          status: r.fetch_status as string | null,
          preferredUsername: r.preferred_username as string | null,
          displayName: r.display_name as string | null,
          summary: r.summary as string | null,
          iconUrl: r.icon_url as string | null,
          imageUrl: r.image_url as string | null,
        });
        return {
          uri: r.uri,
          type: r.type,
          username: actorIdentity.username,
          displayName: actorIdentity.displayName,
          summary: actorIdentity.summary,
          domain: r.domain,
          iconUrl: actorIdentity.iconUrl,
          imageUrl: actorIdentity.imageUrl,
          eventsCount: r.events_count ?? 0,
          followersCount: r.followers_count ?? 0,
          followingCount: r.following_count ?? 0,
        };
      }),
    });
  });

  return router;
}
