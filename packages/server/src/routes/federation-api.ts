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
import type { DB } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  fetchAP,
  resolveRemoteActor,
  fetchRemoteOutbox,
  deliverActivity,
  discoverDomainActors,
} from "../lib/federation.js";
import { generateKeyPair } from "../lib/crypto.js";
import { stripHtml, sanitizeHtml, isPrivateIP } from "../lib/security.js";

export function federationRoutes(db: DB): Hono {
  const router = new Hono();

  // Search for a remote actor via WebFinger (auth required to prevent SSRF)
  router.get("/search", requireAuth(), async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ error: "Query parameter q is required" }, 400);

    // Parse user@domain or @user@domain or full URL
    let actorUri: string | null = null;

    if (q.startsWith("https://") || q.startsWith("http://")) {
      actorUri = q;
    } else {
      const match = q.match(/^@?([^@]+)@([^@]+)$/);
      if (!match) {
        return c.json({ error: "Invalid format. Use user@domain or a URL" }, 400);
      }
      const [, username, domain] = match;

      // WebFinger lookup
      try {
        // SSRF protection: validate domain is not a private/internal address
        if (isPrivateIP(domain)) {
          return c.json({ error: "Requests to private/internal addresses are not allowed" }, 400);
        }

        const wfUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;
        const res = await fetch(wfUrl, {
          headers: { Accept: "application/jrd+json" },
        });
        if (!res.ok) {
          return c.json({ error: `WebFinger lookup failed: ${res.status}` }, 404);
        }
        const wf = (await res.json()) as {
          links: Array<{ rel: string; type?: string; href?: string }>;
        };
        const self = wf.links?.find(
          (l) => l.rel === "self" && l.type === "application/activity+json"
        );
        if (!self?.href) {
          return c.json({ error: "No ActivityPub actor found" }, 404);
        }
        actorUri = self.href;
      } catch (err) {
        return c.json({ error: `WebFinger lookup failed: ${err}` }, 502);
      }
    }

    // Fetch the actor
    const actor = await resolveRemoteActor(db, actorUri, true);
    if (!actor) {
      return c.json({ error: "Could not resolve actor" }, 404);
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
    if (!actorUri) return c.json({ error: "actorUri is required" }, 400);

    const actor = await resolveRemoteActor(db, actorUri, true);
    if (!actor || !actor.outbox) {
      return c.json({ error: "Could not resolve actor or no outbox" }, 404);
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

        storeRemoteEvent(db, fullObj, actor.uri);
        imported++;
      }

      return c.json({ ok: true, imported, total: items.length });
    } catch (err) {
      return c.json({ error: `Failed to fetch outbox: ${err}` }, 502);
    }
  });

  // Follow a remote actor
  router.post("/follow", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const { actorUri } = await c.req.json<{ actorUri: string }>();
    if (!actorUri) return c.json({ error: "actorUri is required" }, 400);

    const actor = await resolveRemoteActor(db, actorUri);
    if (!actor) return c.json({ error: "Could not resolve actor" }, 404);

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

    // Send Follow activity
    const followActivity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${ourActorUrl}#follow-${Date.now()}`,
      type: "Follow",
      actor: ourActorUrl,
      object: actorUri,
    };

    const delivered = await deliverActivity(
      actor.inbox,
      followActivity,
      privateKey,
      `${ourActorUrl}#main-key`
    );

    // Only store as followed if the remote server accepted the Follow
    if (delivered) {
      db.prepare(
        `INSERT OR REPLACE INTO remote_following (account_id, actor_uri, actor_inbox)
         VALUES (?, ?, ?)`
      ).run(user.id, actorUri, actor.inbox);
    }

    return c.json({ ok: true, delivered });
  });

  // Unfollow a remote actor
  router.post("/unfollow", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const { actorUri } = await c.req.json<{ actorUri: string }>();
    if (!actorUri) return c.json({ error: "actorUri is required" }, 400);

    const actor = await resolveRemoteActor(db, actorUri);
    if (!actor) return c.json({ error: "Could not resolve actor" }, 404);

    const account = db
      .prepare("SELECT username, private_key FROM accounts WHERE id = ?")
      .get(user.id) as { username: string; private_key: string | null };

    if (account.private_key) {
      const baseUrl = process.env.BASE_URL || "http://localhost:3000";
      const ourActorUrl = `${baseUrl}/users/${account.username}`;

      const undoActivity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${ourActorUrl}#undo-follow-${Date.now()}`,
        type: "Undo",
        actor: ourActorUrl,
        object: {
          type: "Follow",
          actor: ourActorUrl,
          object: actorUri,
        },
      };

      await deliverActivity(
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

    return c.json({ ok: true });
  });

  // List remote events
  router.get("/remote-events", (c) => {
    const actorUri = c.req.query("actor");
    const from = c.req.query("from");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let sql = `
      SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
             ra.domain, ra.icon_url AS actor_icon_url
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
      sql += " AND re.start_date >= ?";
      params.push(from);
    }

    sql += " ORDER BY re.start_date ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return c.json({
      events: rows.map((row) => ({
        uri: row.uri,
        actorUri: row.actor_uri,
        actor: row.preferred_username
          ? {
              username: row.preferred_username,
              displayName: row.actor_display_name,
              domain: row.domain,
              iconUrl: row.actor_icon_url,
            }
          : null,
        title: row.title,
        description: row.description,
        startDate: row.start_date,
        endDate: row.end_date,
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
        published: row.published,
        updated: row.updated,
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
      actors: rows.map((r) => ({
        uri: r.uri,
        type: r.type,
        username: r.preferred_username,
        displayName: r.display_name,
        summary: r.summary,
        domain: r.domain,
        iconUrl: r.icon_url,
        imageUrl: r.image_url,
        outbox: r.outbox,
        followersCount: r.followers_count ?? 0,
        followingCount: r.following_count ?? 0,
      })),
    });
  });

  // Refresh stale remote actor data (auth required — triggers outbound requests)
  // Also discovers new profiles from domains that support directory API
  router.post("/refresh-actors", requireAuth(), async (c) => {
    const maxRefresh = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
    const maxAgeHours = parseInt(c.req.query("maxAgeHours") || "24", 10);
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

    const stale = db
      .prepare(
        `SELECT uri FROM remote_actors WHERE last_fetched_at < ? ORDER BY last_fetched_at ASC LIMIT ?`
      )
      .all(cutoff, maxRefresh) as { uri: string }[];

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
      actors: rows.map((r) => ({
        uri: r.uri,
        type: r.type,
        username: r.preferred_username,
        displayName: r.display_name,
        summary: r.summary,
        domain: r.domain,
        iconUrl: r.icon_url,
        imageUrl: r.image_url,
        eventsCount: r.events_count ?? 0,
        followersCount: r.followers_count ?? 0,
        followingCount: r.following_count ?? 0,
      })),
    });
  });

  return router;
}

function storeRemoteEvent(
  db: DB,
  object: Record<string, unknown>,
  actorUri: string
) {
  const tags = (object.tag as Array<{ name: string }>) || [];
  const tagString = tags
    .map((t) => stripHtml(t.name?.replace(/^#/, "") || ""))
    .filter(Boolean)
    .join(",");

  // Sanitize content from remote servers (support both ActivityStreams and Schema.org property names)
  const title =
    typeof object.name === "string"
      ? stripHtml(object.name)
      : typeof object.title === "string"
        ? stripHtml(object.title)
        : "";
  const description = typeof object.content === "string" ? sanitizeHtml(object.content) : null;

  const loc = object.location as Record<string, unknown> | undefined;
  let locationAddress: string | null = null;
  if (loc?.address) {
    if (typeof loc.address === "string") {
      locationAddress = stripHtml(loc.address);
    } else {
      const addr = loc.address as Record<string, string>;
      locationAddress = [
        addr.streetAddress,
        addr.postalCode,
        addr.addressLocality,
        addr.addressCountry,
      ]
        .filter(Boolean)
        .map((s) => stripHtml(s))
        .join(", ");
    }
  }

  const attachments =
    (object.attachment as Array<Record<string, unknown>>) || [];
  const image = attachments.find(
    (a) => a.type === "Image" || a.type === "Document"
  );

  db.prepare(
    `INSERT INTO remote_events (uri, actor_uri, title, description, start_date, end_date,
      location_name, location_address, location_latitude, location_longitude,
      image_url, image_media_type, image_alt, url, tags, raw_json, published, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      start_date=excluded.start_date, end_date=excluded.end_date,
      location_name=excluded.location_name, location_address=excluded.location_address,
      location_latitude=excluded.location_latitude, location_longitude=excluded.location_longitude,
      image_url=excluded.image_url, image_media_type=excluded.image_media_type,
      image_alt=excluded.image_alt, url=excluded.url, tags=excluded.tags,
      raw_json=excluded.raw_json, updated=excluded.updated, fetched_at=datetime('now')`
  ).run(
    object.id as string,
    actorUri,
    title,
    description,
    (object.startTime ?? object.startDate) as string,
    ((object.endTime ?? object.endDate) as string) || null,
    loc?.name ? stripHtml(loc.name as string) : null,
    locationAddress,
    (loc?.latitude as number) ?? null,
    (loc?.longitude as number) ?? null,
    (image?.url as string) || null,
    (image?.mediaType as string) || null,
    (image?.name as string) || null,
    (object.url as string) || null,
    tagString || null,
    // Limit raw_json to 100KB to prevent storage abuse
    JSON.stringify(object).slice(0, 100_000),
    (object.published as string) || null,
    (object.updated as string) || null
  );
}
