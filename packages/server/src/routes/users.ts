/**
 * User routes — public profiles, follow/unfollow.
 */

import { Hono } from "hono";
import type { DB } from "../db.js";
import {
  buildDateRangeFilter,
  DateQueryParamError,
  parseDateRangeParams,
} from "../lib/date-query.js";
import { requireAuth } from "../middleware/auth.js";
import {
  formatRemoteActorAccount,
  formatRemoteActorIdentity,
  parseRemoteActorUri,
  resolveRemoteActor,
  fetchRemoteCollection,
} from "../lib/federation.js";
import { getLocale, t } from "../lib/i18n.js";
import { listActingAccounts } from "../lib/identities.js";
import {
  ActorSelectionPayloadError,
  applyLocalActorSelection,
  buildActorSelectionPlan,
  isDesiredAccountIdsAllowed,
  readActorSelectionPayload,
  summarizeActorSelection,
} from "../lib/actor-selection.js";
import { normalizeEventTimezone } from "../lib/event-timezone.js";
import { PaginationParamError, parseLimitOffset } from "../lib/pagination.js";
import { buildActorUrl, buildUrl } from "../lib/base-url.js";
import { buildPublicEventsCountSubquery, loadPublicEventsCountsByAccountId } from "../lib/activity-count.js";
import { parseRemoteHandle } from "../lib/remote-handle.js";

export function userRoutes(db: DB): Hono {
  const router = new Hono();

  // List users (public — only discoverable accounts)
  router.get("/", (c) => {
    const q = c.req.query("q") || "";
    let limit: number;
    let offset: number;
    try {
      ({ limit, offset } = parseLimitOffset(c, { defaultLimit: 20, maxLimit: 100 }));
    } catch (error) {
      if (error instanceof PaginationParamError) return c.json({ error: error.message }, 400);
      throw error;
    }

    let sql: string;
    let params: unknown[];

    const followersCountSubquery = `(SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) + (SELECT COUNT(*) FROM remote_follows WHERE account_id = accounts.id)`;

    if (q) {
      sql = `SELECT id, username, account_type, display_name, bio, avatar_url, website, is_bot, discoverable, created_at,
                    ${followersCountSubquery} AS followers_count,
                    (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count
             FROM accounts
             WHERE discoverable = 1 AND (username LIKE ? OR display_name LIKE ?)
             ORDER BY username ASC LIMIT ? OFFSET ?`;
      params = [`%${q}%`, `%${q}%`, limit, offset];
    } else {
      sql = `SELECT id, username, account_type, display_name, bio, avatar_url, website, is_bot, discoverable, created_at,
                    ${followersCountSubquery} AS followers_count,
                    (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count
             FROM accounts
             WHERE discoverable = 1
             ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params = [limit, offset];
    }

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    const accountIds = rows.map((row) => row.id as string);
    const eventsCountByAccountId = loadPublicEventsCountsByAccountId(db, accountIds);
    for (const row of rows) {
      const accountId = row.id as string;
      row.events_count = eventsCountByAccountId.get(accountId) ?? 0;
    }
    return c.json({ users: rows.map(formatUser) });
  });

  // Get user profile (local or remote)
  router.get("/:username", (c) => {
    const username = c.req.param("username");
    const currentUser = c.get("user");

    // Remote profile: username@domain format
    const remoteHandle = parseRemoteHandle(username);
    if (remoteHandle) {
      const { localPart, domain } = remoteHandle;
        const remoteRow = db
          .prepare(
            `SELECT ra.uri, ra.preferred_username, ra.display_name, ra.summary, ra.icon_url, ra.image_url, ra.domain,
                    ra.followers_count, ra.following_count, ra.fetch_status,
                    (SELECT COUNT(*) FROM remote_events WHERE actor_uri = ra.uri) AS events_count
             FROM remote_actors ra WHERE ra.preferred_username = ? AND ra.domain = ?`
          )
          .get(localPart, domain) as Record<string, unknown> | undefined;

        if (!remoteRow) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

        const following = currentUser
          ? db
              .prepare("SELECT 1 FROM remote_following WHERE account_id = ? AND actor_uri = ?")
              .get(currentUser.id, remoteRow.uri)
          : null;

        const account = formatRemoteActorAccount({
          status: remoteRow.fetch_status as string | null,
          preferredUsername: remoteRow.preferred_username as string | null,
          displayName: remoteRow.display_name as string | null,
          domain: remoteRow.domain as string | null,
          iconUrl: remoteRow.icon_url as string | null,
        });
        const actorIdentity = formatRemoteActorIdentity({
          status: remoteRow.fetch_status as string | null,
          preferredUsername: remoteRow.preferred_username as string | null,
          displayName: remoteRow.display_name as string | null,
          summary: remoteRow.summary as string | null,
          iconUrl: remoteRow.icon_url as string | null,
          imageUrl: remoteRow.image_url as string | null,
        });
        return c.json({
          id: remoteRow.uri,
          username: account?.username || username,
          displayName: actorIdentity.displayName,
          bio: actorIdentity.summary,
          avatarUrl: actorIdentity.iconUrl,
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
        });
    }

    const eventsCountSubquery = `${buildPublicEventsCountSubquery()} AS events_count`;

    const followersCountSubquery = `(SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) + (SELECT COUNT(*) FROM remote_follows WHERE account_id = accounts.id)`;

    const row = db
      .prepare(
        `SELECT id, username, account_type, display_name, bio, avatar_url, website, is_bot, discoverable, created_at,
                ${followersCountSubquery} AS followers_count,
                (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count,
                ${eventsCountSubquery}
         FROM accounts WHERE username = ?`
      )
      .get(username) as Record<string, unknown> | undefined;

    if (!row) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const result = formatUser(row);

    // Add follow status and auto-repost status if logged in
    if (currentUser) {
      const follow = db
        .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
        .get(currentUser.id, row.id);
      result.following = !!follow;

      const autoRepost = db
        .prepare("SELECT 1 FROM auto_reposts WHERE account_id = ? AND (source_account_id = ? OR source_actor_uri = ?)")
        .get(currentUser.id, row.id, buildActorUrl(row.username as string));
      result.autoReposting = !!autoRepost;
    }

    return c.json(result);
  });

  // Get user's events (own + reposted + auto-reposted) or remote actor's events
  router.get("/:username/events", (c) => {
    const username = c.req.param("username");
    const currentUser = c.get("user");
    const from = c.req.query("from");
    const to = c.req.query("to");
    try {
      parseDateRangeParams(from, to);
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
    const sort = c.req.query("sort")?.toLowerCase() === "desc" ? "DESC" : "ASC";
    let limit: number;
    let offset: number;
    try {
      ({ limit, offset } = parseLimitOffset(c, { defaultLimit: 50, maxLimit: 200 }));
    } catch (error) {
      if (error instanceof PaginationParamError) return c.json({ error: error.message }, 400);
      throw error;
    }

    // Remote profile: username@domain format
    const remoteHandle = parseRemoteHandle(username);
    if (remoteHandle) {
      const { localPart, domain } = remoteHandle;
        const remoteActor = db
          .prepare("SELECT uri FROM remote_actors WHERE preferred_username = ? AND domain = ?")
          .get(localPart, domain) as { uri: string } | undefined;
        if (!remoteActor) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

        let sql = `
          SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
                 ra.domain, ra.icon_url AS actor_icon_url, ra.fetch_status AS actor_fetch_status
          FROM remote_events re
          LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri
          WHERE re.actor_uri = ?
        `;
        const params: unknown[] = [remoteActor.uri];
        const range = buildDateRangeFilter(
          { instantColumn: "re.start_at_utc", dateColumn: "re.start_on" },
          from,
          to,
        );
        sql += range.sql;
        params.push(...range.params);
        sql += ` ORDER BY re.start_at_utc ${sort} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
        let events = rows.map(formatRemoteEventForUser);
        if (currentUser && events.length > 0) {
          const uris = events.map((e) => e.id as string);
          const placeholders = uris.map(() => "?").join(",");
          const rsvpRows = db
            .prepare(`SELECT event_uri, status FROM event_rsvps WHERE account_id = ? AND event_uri IN (${placeholders})`)
            .all(currentUser.id, ...uris) as { event_uri: string; status: string }[];
          const rsvpMap = new Map(rsvpRows.map((r) => [r.event_uri, r.status]));
          events = events.map((e) => ({ ...e, rsvpStatus: rsvpMap.get(e.id as string) || null }));
        }
        return c.json({ events });
    }

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const isOwner = currentUser?.id === account.id;
    const isFollower = currentUser
      ? !!db
          .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
          .get(currentUser.id, account.id)
      : false;

    // Determine which visibilities this viewer can see (using parameterized query)
    const allowedVisibilities = ["public", "unlisted"];
    if (isFollower) allowedVisibilities.push("followers_only");
    if (isOwner) allowedVisibilities.push("private");
    const visibilityPlaceholders = allowedVisibilities.map(() => "?").join(",");

    // Own events
    let sql = `
      SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
             GROUP_CONCAT(DISTINCT t.tag) AS tags,
             NULL AS repost_username, NULL AS repost_display_name
      FROM events e
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN event_tags t ON t.event_id = e.id
      WHERE e.account_id = ?
        AND e.visibility IN (${visibilityPlaceholders})
    `;
    const params: unknown[] = [account.id, ...allowedVisibilities];

    {
      const range = buildDateRangeFilter(
        { instantColumn: "e.start_at_utc", dateColumn: "e.start_on" },
        from,
        to,
      );
      sql += range.sql;
      params.push(...range.params);
    }

    sql += ` GROUP BY e.id`;

    // Visibility filter for reposts/auto-reposts: show if viewer is in addressees (public/unlisted = all; followers_only = followers of creator; private = creator only)
    const repostVisibilityClause = currentUser
      ? `AND (
          e.visibility IN ('public','unlisted')
          OR (e.visibility = 'followers_only' AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id))
          OR (e.visibility = 'private' AND e.account_id = ?)
        )`
      : `AND e.visibility IN ('public','unlisted')`;
    const repostVisibilityParams = currentUser ? [currentUser.id, currentUser.id] : [];

    // Add explicit reposts
    sql += `
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
    `;
    params.push(account.id, ...repostVisibilityParams);
    {
      const range = buildDateRangeFilter(
        { instantColumn: "e.start_at_utc", dateColumn: "e.start_on" },
        from,
        to,
      );
      sql += range.sql;
      params.push(...range.params);
    }
    sql += ` GROUP BY e.id`;

    // Add auto-reposted events (from accounts this user auto-reposts, excluding already explicit reposts)
    const autoRepostVisibilityClause = currentUser
      ? `AND (
          e.visibility IN ('public','unlisted')
          OR (e.visibility = 'followers_only' AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id))
          OR (e.visibility = 'private' AND e.account_id = ?)
        )`
      : `AND e.visibility IN ('public','unlisted')`;
    const autoRepostVisibilityParams = currentUser ? [currentUser.id, currentUser.id] : [];

    sql += `
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
        AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ? AND event_id IS NOT NULL)
    `;
    params.push(account.id, ...autoRepostVisibilityParams, account.id, account.id);
    {
      const range = buildDateRangeFilter(
        { instantColumn: "e.start_at_utc", dateColumn: "e.start_on" },
        from,
        to,
      );
      sql += range.sql;
      params.push(...range.params);
    }
    sql += ` GROUP BY e.id`;

    // Wrap in outer query to sort and paginate
    const fullSql = `SELECT * FROM (${sql}) ORDER BY start_at_utc ${sort} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(fullSql).all(...params) as Record<string, unknown>[];
    return c.json({ events: rows.map(formatEvent) });
  });

  // Follow a user
  router.post("/:username/follow", requireAuth(), async (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");

    const target = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!target) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);
    let body: { actorUri?: string; desiredAccountIds?: string[] };
    try {
      body = await readActorSelectionPayload(c);
    } catch (err) {
      if (err instanceof ActorSelectionPayloadError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    if (!body.desiredAccountIds) {
      if (target.id === currentUser.id) return c.json({ error: t(getLocale(c), "users.cannot_follow_yourself") }, 400);
      db.prepare("INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)").run(currentUser.id, target.id);
      return c.json({ ok: true, following: true });
    }

    const acting = listActingAccounts(db, currentUser.id, "editor");
    const actingIds = acting.map((a) => a.id);
    if (!isDesiredAccountIdsAllowed(body.desiredAccountIds, actingIds)) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const activeRows = db
      .prepare("SELECT follower_id FROM follows WHERE following_id = ?")
      .all(target.id) as Array<{ follower_id: string }>;
    const plan = buildActorSelectionPlan({
      actingAccountIds: actingIds,
      desiredAccountIds: body.desiredAccountIds,
      activeAccountIds: activeRows.map((r) => r.follower_id),
      validateTransition: ({ accountId, after }) => {
        if (accountId === target.id && after) return t(getLocale(c), "users.cannot_follow_yourself");
        return null;
      },
    });

    const { operationId, results } = applyLocalActorSelection({
      db,
      operation: {
        actionKind: "follow",
        targetType: "account",
        targetId: target.id,
        initiatedByAccountId: currentUser.id,
      },
      plan,
      applyAdd: (accountId) => {
        db.prepare("INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)").run(accountId, target.id);
      },
      applyRemove: (accountId) => {
        db.prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?").run(accountId, target.id);
      },
    });
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

  // Unfollow a user
  router.post("/:username/unfollow", requireAuth(), (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");

    const target = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!target) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    db.prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?").run(
      currentUser.id,
      target.id
    );

    return c.json({ ok: true, following: false });
  });

  // Auto-repost: automatically include all public events from target on your feed
  router.post("/:username/auto-repost", requireAuth(), async (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");

    const remoteHandle = parseRemoteHandle(username);
    const localTarget = !remoteHandle
      ? db.prepare("SELECT id, username FROM accounts WHERE username = ?").get(username) as { id: string; username: string } | undefined
      : undefined;
    let sourceActorUri: string | null = null;
    let sourceAccountId: string | null = null;
    if (localTarget) {
      sourceAccountId = localTarget.id;
      sourceActorUri = buildActorUrl(localTarget.username);
    } else if (remoteHandle) {
      const { localPart, domain } = remoteHandle;
      let remote = db.prepare("SELECT uri FROM remote_actors WHERE preferred_username = ? AND domain = ?").get(localPart, domain) as { uri: string } | undefined;
      if (!remote) {
        const actorUri = buildUrl(`https://${domain}`, "users", localPart);
        const resolved = await resolveRemoteActor(db, actorUri);
        if (resolved?.uri) remote = { uri: resolved.uri };
      }
      sourceActorUri = remote?.uri ?? null;
    }
    if (!sourceActorUri) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);
    let body: { actorUri?: string; desiredAccountIds?: string[] };
    try {
      body = await readActorSelectionPayload(c);
    } catch (err) {
      if (err instanceof ActorSelectionPayloadError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    if (!body.desiredAccountIds) {
      if (sourceAccountId === currentUser.id) return c.json({ error: t(getLocale(c), "users.cannot_autorepost_yourself") }, 400);
      db.prepare("INSERT OR IGNORE INTO auto_reposts (account_id, source_account_id, source_actor_uri) VALUES (?, ?, ?)").run(
        currentUser.id,
        sourceAccountId,
        sourceActorUri,
      );
      return c.json({ ok: true, autoReposting: true });
    }

    const acting = listActingAccounts(db, currentUser.id, "editor");
    const actingIds = acting.map((a) => a.id);
    if (!isDesiredAccountIdsAllowed(body.desiredAccountIds, actingIds)) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const activeRows = db
      .prepare("SELECT account_id FROM auto_reposts WHERE source_actor_uri = ? OR (? IS NOT NULL AND source_account_id = ?)")
      .all(sourceActorUri, sourceAccountId, sourceAccountId) as Array<{ account_id: string }>;
    const plan = buildActorSelectionPlan({
      actingAccountIds: actingIds,
      desiredAccountIds: body.desiredAccountIds,
      activeAccountIds: activeRows.map((r) => r.account_id),
      validateTransition: ({ accountId, after }) => {
        if (sourceAccountId && accountId === sourceAccountId && after) return t(getLocale(c), "users.cannot_autorepost_yourself");
        return null;
      },
    });

    const { operationId, results } = applyLocalActorSelection({
      db,
      operation: {
        actionKind: "auto_repost",
        targetType: "account",
        targetId: sourceActorUri,
        initiatedByAccountId: currentUser.id,
      },
      plan,
      applyAdd: (accountId) => {
        db.prepare("INSERT OR IGNORE INTO auto_reposts (account_id, source_account_id, source_actor_uri) VALUES (?, ?, ?)").run(accountId, sourceAccountId, sourceActorUri);
      },
      applyRemove: (accountId) => {
        db.prepare("DELETE FROM auto_reposts WHERE account_id = ? AND (source_actor_uri = ? OR (? IS NOT NULL AND source_account_id = ?))").run(accountId, sourceActorUri, sourceAccountId, sourceAccountId);
      },
    });
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

  router.get("/:username/follow-actors", requireAuth(), (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");
    const target = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!target) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const acting = listActingAccounts(db, currentUser.id, "editor");
    const allowed = new Set(acting.map((a) => a.id));
    const activeRows = db
      .prepare("SELECT follower_id FROM follows WHERE following_id = ?")
      .all(target.id) as Array<{ follower_id: string }>;
    const activeAccountIds = activeRows.map((r) => r.follower_id).filter((id) => allowed.has(id));

    return c.json({ activeAccountIds, actorIds: Array.from(allowed) });
  });

  router.get("/:username/auto-repost-actors", requireAuth(), (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");
    const target = db.prepare("SELECT id, username FROM accounts WHERE username = ?").get(username) as { id: string; username: string } | undefined;
    if (!target) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const acting = listActingAccounts(db, currentUser.id, "editor");
    const allowed = new Set(acting.map((a) => a.id));
    const activeRows = db
      .prepare("SELECT account_id FROM auto_reposts WHERE source_actor_uri = ? OR source_account_id = ?")
      .all(buildActorUrl(target.username), target.id) as Array<{ account_id: string }>;
    const activeAccountIds = activeRows.map((r) => r.account_id).filter((id) => allowed.has(id));

    return c.json({ activeAccountIds, actorIds: Array.from(allowed) });
  });

  // Remove auto-repost
  router.delete("/:username/auto-repost", requireAuth(), (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");

    const target = db
      .prepare("SELECT id, username FROM accounts WHERE username = ?")
      .get(username) as { id: string; username: string } | undefined;
    if (!target) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    db.prepare("DELETE FROM auto_reposts WHERE account_id = ? AND (source_account_id = ? OR source_actor_uri = ?)").run(
      currentUser.id,
      target.id,
      buildActorUrl(target.username),
    );

    return c.json({ ok: true, autoReposting: false });
  });

  // Get followers (local + remote)
  router.get("/:username/followers", async (c) => {
    const username = c.req.param("username");

    // Remote profile: username@domain format
    const remoteHandle = parseRemoteHandle(username);
    if (remoteHandle) {
      const { localPart, domain } = remoteHandle;
        let actor = db
          .prepare("SELECT uri, followers_url FROM remote_actors WHERE preferred_username = ? AND domain = ?")
          .get(localPart, domain) as { uri: string; followers_url: string | null } | undefined;
        if (!actor) {
          const actorUri = buildUrl(`https://${domain}`, "users", localPart);
          const resolved = await resolveRemoteActor(db, actorUri);
          actor = resolved ? { uri: resolved.uri, followers_url: resolved.followers_url } : undefined;
        }
        if (!actor?.followers_url) {
          return c.json({ users: [] });
        }
        try {
          const uris = await fetchRemoteCollection(actor.followers_url);
          const users = uris.map((uri) => actorUriToUser(uri)).filter((u) => u.username);
          return c.json({ users });
        } catch {
          return c.json({ users: [] });
        }
    }

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const localRows = db
      .prepare(
        `SELECT a.id, a.username, a.display_name, a.avatar_url
         FROM follows f
         JOIN accounts a ON a.id = f.follower_id
         WHERE f.following_id = ?
         ORDER BY f.created_at DESC`
      )
      .all(account.id) as Record<string, unknown>[];

    const remoteRows = db
      .prepare(
        `SELECT rf.follower_actor_uri, ra.preferred_username, ra.display_name, ra.icon_url, ra.domain
                , ra.fetch_status
         FROM remote_follows rf
         LEFT JOIN remote_actors ra ON ra.uri = rf.follower_actor_uri
         WHERE rf.account_id = ?
         ORDER BY rf.created_at DESC`
      )
      .all(account.id) as Record<string, unknown>[];

    const localUsers = localRows.map((r) => ({ ...formatUser(r), source: "local" as const }));
    const remoteUsers = remoteRows.map((r) => formatRemoteFollower(r));
    const users = [...localUsers, ...remoteUsers];

    return c.json({ users });
  });

  // Get following (local + remote)
  router.get("/:username/following", async (c) => {
    const username = c.req.param("username");

    // Remote profile: username@domain format
    const remoteHandle = parseRemoteHandle(username);
    if (remoteHandle) {
      const { localPart, domain } = remoteHandle;
        let actor = db
          .prepare("SELECT uri, following_url FROM remote_actors WHERE preferred_username = ? AND domain = ?")
          .get(localPart, domain) as { uri: string; following_url: string | null } | undefined;
        if (!actor) {
          const actorUri = buildUrl(`https://${domain}`, "users", localPart);
          const resolved = await resolveRemoteActor(db, actorUri);
          actor = resolved ? { uri: resolved.uri, following_url: resolved.following_url } : undefined;
        }
        if (!actor?.following_url) {
          return c.json({ users: [] });
        }
        try {
          const uris = await fetchRemoteCollection(actor.following_url);
          const users = uris.map((uri) => actorUriToUser(uri)).filter((u) => u.username);
          return c.json({ users });
        } catch {
          return c.json({ users: [] });
        }
    }

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: t(getLocale(c), "users.user_not_found") }, 404);

    const localRows = db
      .prepare(
        `SELECT a.id, a.username, a.display_name, a.avatar_url
         FROM follows f
         JOIN accounts a ON a.id = f.following_id
         WHERE f.follower_id = ?
         ORDER BY f.created_at DESC`
      )
      .all(account.id) as Record<string, unknown>[];

    const remoteRows = db
      .prepare(
        `SELECT rf.actor_uri, ra.preferred_username, ra.display_name, ra.icon_url, ra.domain
                , ra.fetch_status
         FROM remote_following rf
         LEFT JOIN remote_actors ra ON ra.uri = rf.actor_uri
         WHERE rf.account_id = ?
         ORDER BY rf.created_at DESC`
      )
      .all(account.id) as Record<string, unknown>[];

    const localUsers = localRows.map((r) => ({ ...formatUser(r), source: "local" as const }));
    const remoteUsers = remoteRows.map((r) => formatRemoteFollowing(r));
    const users = [...localUsers, ...remoteUsers];

    return c.json({ users });
  });

  return router;
}

function formatRemoteEventForUser(row: Record<string, unknown>): Record<string, unknown> {
  const account = formatRemoteActorAccount({
    status: row.actor_fetch_status as string | null,
    preferredUsername: row.preferred_username as string | null,
    displayName: row.actor_display_name as string | null,
    domain: row.domain as string | null,
    iconUrl: row.actor_icon_url as string | null,
  });
  return {
    id: row.uri,
    slug: row.slug,
    source: "remote",
    actorUri: row.actor_uri,
    account,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    startAtUtc: row.start_at_utc ?? undefined,
    endAtUtc: row.end_at_utc ?? undefined,
    eventTimezone: row.event_timezone ?? undefined,
    timezoneQuality: row.timezone_quality as "exact_tzid" | "offset_only" | undefined,
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
    ogImageUrl: row.og_image_url || null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: "public",
    canceled: !!row.canceled,
    createdAt: row.published,
    updatedAt: row.updated,
  };
}

function formatUser(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    username: row.username,
    accountType: row.account_type,
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
}

/** Convert an actor URI to a minimal User object for remote followers/following lists */
function actorUriToUser(uri: string): Record<string, unknown> {
  const { username: parsedUser, domain: parsedDomain } = parseRemoteActorUri(uri);
  if (parsedUser === "unknown" && parsedDomain === "unknown") return {};
  const username = `${parsedUser}@${parsedDomain}`;
  return {
    id: uri,
    username,
    displayName: null,
    avatarUrl: null,
    domain: parsedDomain,
    source: "remote",
  };
}

function formatRemoteFollower(row: Record<string, unknown>): Record<string, unknown> {
  const uri = row.follower_actor_uri as string;
  const { username: parsedUser, domain: parsedDomain } = parseRemoteActorUri(uri);
  const domain = (row.domain as string) || parsedDomain;
  const account = formatRemoteActorAccount({
    status: row.fetch_status as string | null,
    preferredUsername: row.preferred_username as string | null,
    displayName: row.display_name as string | null,
    domain,
    iconUrl: row.icon_url as string | null,
  });
  const username = account?.username || `${parsedUser}@${parsedDomain}`;
  return {
    id: uri,
    username,
    displayName: account?.displayName || null,
    avatarUrl: account?.iconUrl || null,
    domain,
    source: "remote",
  };
}

function formatRemoteFollowing(row: Record<string, unknown>): Record<string, unknown> {
  const uri = row.actor_uri as string;
  const { username: parsedUser, domain: parsedDomain } = parseRemoteActorUri(uri);
  const domain = (row.domain as string) || parsedDomain;
  const account = formatRemoteActorAccount({
    status: row.fetch_status as string | null,
    preferredUsername: row.preferred_username as string | null,
    displayName: row.display_name as string | null,
    domain,
    iconUrl: row.icon_url as string | null,
  });
  const username = account?.username || `${parsedUser}@${parsedDomain}`;
  return {
    id: uri,
    username,
    displayName: account?.displayName || null,
    avatarUrl: account?.iconUrl || null,
    domain,
    source: "remote",
  };
}

function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  const eventTimezone = normalizeEventTimezone(row.event_timezone);
  return {
    id: row.id,
    slug: row.slug,
    accountId: row.account_id,
    account: row.account_username
      ? { username: row.account_username, displayName: row.account_display_name }
      : undefined,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    startAtUtc: row.start_at_utc ?? undefined,
    endAtUtc: row.end_at_utc ?? undefined,
    eventTimezone,
    timezoneQuality: "exact_tzid",
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
      ? { url: row.image_url, mediaType: row.image_media_type, alt: row.image_alt }
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
