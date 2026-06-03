import type { Hono } from "hono";
import { toErrorMessage } from "@everycal/core";
import type { DB } from "../../db.js";
import { buildFeedQuery } from "../../lib/feed-query.js";
import { DateQueryParamError } from "../../lib/date-query.js";
import { getLocale, t } from "../../lib/i18n.js";
import { PaginationParamError, parseLimitOffset } from "../../lib/pagination.js";
import { requireAuth } from "../../middleware/auth.js";
import { deriveVisibilityFromActivityPubAddressing, fetchAP, resolveRemoteActor, validateFederationUrl } from "../../lib/federation.js";
import { uniqueRemoteEventSlug } from "../../lib/slugs.js";
import { upsertRemoteEvent } from "../../lib/remote-events.js";
import { normalizeApTemporal } from "../../lib/timezone.js";
import { getBaseUrl } from "../../lib/base-url.js";
import { parseRemoteHandle } from "../../lib/remote-handle.js";
import type { EventRouteContext } from "./context.js";
import { appendDateRangeFilters, buildRemoteTagFilter, buildRemoteVisibilityFilter, formatEvent, formatRemoteEvent, LOCAL_EVENT_SELECT, paginateMergedFromFetchers, REMOTE_EVENT_SELECT, resolveEventUri, validateMergedCursorParam, type MergedFetcher } from "./shared.js";

function canViewRemoteByVisibility(db: DB, visibility: string, actorUri: string, currentUserId?: string): boolean {
  if (visibility === "public" || visibility === "unlisted") return true;
  if (!currentUserId) return false;
  if (visibility === "followers_only") {
    return !!db
      .prepare("SELECT 1 FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get(currentUserId, actorUri);
  }
  return false;
}

export function registerEventReadRoutes(router: Hono, db: DB, context: EventRouteContext): void {
  const { attachUserContext, attachSingleEventContext, fetchLocalEvent, getUserRsvps } = context;
  const eventColumns = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const hasEventModerationStateColumn = eventColumns.some((column) => column.name === "moderation_state");
  const appendVisibleLocalEventFilter = (sql: string, col: string): string => {
    if (!hasEventModerationStateColumn) return sql;
    return `${sql} AND COALESCE(${col}.moderation_state, 'visible') != 'hidden'`;
  };
  // ─── GET /tags ──────────────────────────────────────────────────────────

  router.get("/tags", (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const scope = c.req.query("scope");
    const user = c.get("user");
    const isMineScope = scope === "mine" && !!user;
    const isCalendarScope = scope === "calendar" && !!user;

    const allTags = new Set<string>();

    try {
      // Local event tags
      {
        let sql: string;
        const params: unknown[] = [];

        if (isCalendarScope) {
          sql = `SELECT DISTINCT t.tag FROM event_tags t
            JOIN events e ON e.id = t.event_id
            WHERE e.id IN (SELECT event_uri FROM event_rsvps WHERE account_id = ? AND status IN ('going','maybe'))
            AND (
              e.visibility IN ('public','unlisted')
              OR e.account_id = ?
              OR (e.visibility = 'followers_only' AND EXISTS (
                SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id
              ))
            )`;
          params.push(user!.id, user!.id, user!.id);
        } else if (isMineScope) {
          const baseUrl = getBaseUrl();
          const feed = buildFeedQuery({ userId: user!.id, baseUrl });
          sql = `SELECT DISTINCT t.tag FROM event_tags t
            WHERE t.event_id IN (SELECT combined.id FROM (${feed.sql}) AS combined WHERE 1=1`;
          params.push(...feed.params);
        } else {
          sql = `SELECT DISTINCT t.tag FROM event_tags t
            JOIN events e ON e.id = t.event_id
            JOIN accounts a ON a.id = e.account_id
            WHERE e.visibility = 'public'`;
        }

        const df = appendDateRangeFilters(
          {
            instantColumn: isMineScope ? "combined.start_at_utc" : "e.start_at_utc",
            dateColumn: isMineScope ? "combined.start_on" : "e.start_on",
          },
          from,
          to,
        );
        sql += df.sql;
        params.push(...df.params);

        if (isMineScope) sql += ")";

        const rows = db.prepare(sql).all(...params) as { tag: string }[];
        for (const r of rows) allTags.add(r.tag);
      }

      // Remote event tags
      {
        let sql = `SELECT re.tags FROM remote_events re WHERE re.tags IS NOT NULL AND re.tags != ''`;
        const params: unknown[] = [];
        const remoteVisibility = buildRemoteVisibilityFilter(user?.id);

        sql += ` AND ${remoteVisibility.sql}`;
        params.push(...remoteVisibility.params);

        if (isCalendarScope) {
          sql += ` AND re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ? AND status IN ('going','maybe'))`;
          params.push(user!.id);
        } else if (isMineScope) {
          sql += ` AND (re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?) OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?))`;
          params.push(user!.id, user!.id);
        }

        const df = appendDateRangeFilters({ instantColumn: "re.start_at_utc", dateColumn: "re.start_on" }, from, to);
        sql += df.sql;
        params.push(...df.params);

        const rows = db.prepare(sql).all(...params) as { tags: string }[];
        for (const r of rows) {
          for (const tag of r.tags.split(",")) {
            const t = tag.trim();
            if (t) allTags.add(t);
          }
        }
      }

      return c.json({ tags: [...allTags].sort() });
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // ─── GET / — list events ───────────────────────────────────────────────

  router.get("/", (c) => {
    const account = c.req.query("account");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const q = c.req.query("q");
    const source = c.req.query("source");
    const scope = c.req.query("scope");
    const cursor = c.req.query("cursor");
    const tagsParam = c.req.query("tags");
    try {
      validateMergedCursorParam(cursor);
      const { limit, offset } = parseLimitOffset(c, { defaultLimit: 50, maxLimit: 200 });
      const tagList = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const user = c.get("user");
      const isMineScope = scope === "mine" && !!user;
      const isCalendarScope = scope === "calendar" && !!user;

      const buildLocalQueryBase = (): { sql: string; params: unknown[]; col: string } => {
      let sql: string;
      const params: unknown[] = [];

      if (isCalendarScope) {
        sql = `${LOCAL_EVENT_SELECT}
          WHERE e.id IN (
            SELECT event_uri FROM event_rsvps
            WHERE account_id = ? AND status IN ('going','maybe')
          )
          AND (
            e.visibility IN ('public','unlisted')
            OR e.account_id = ?
            OR (e.visibility = 'followers_only' AND EXISTS (
              SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id
            ))
          )`;
        params.push(user!.id, user!.id, user!.id);
      } else if (isMineScope) {
        const baseUrl = getBaseUrl();
        const feed = buildFeedQuery({ userId: user!.id, baseUrl });
        sql = feed.sql;
        params.push(...feed.params);
      } else if (user) {
        sql = `${LOCAL_EVENT_SELECT} WHERE (e.visibility = 'public' OR e.account_id = ?)`;
        params.push(user.id);
      } else {
        sql = `${LOCAL_EVENT_SELECT} WHERE e.visibility = 'public'`;
      }

      const col = isMineScope ? "combined" : "e";
      sql = appendVisibleLocalEventFilter(sql, col);
      if (account) {
        sql += isMineScope ? " AND combined.account_username = ?" : " AND a.username = ?";
        params.push(account);
      }

      const df = appendDateRangeFilters(
        { instantColumn: `${col}.start_at_utc`, dateColumn: `${col}.start_on` },
        from,
        to,
      );
      sql += df.sql;
      params.push(...df.params);

      if (q) {
        sql += ` AND (${col}.title LIKE ? OR ${col}.description LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`);
      }
      if (tagList.length > 0) {
        const placeholders = tagList.map(() => "?").join(",");
        sql += ` AND ${col}.id IN (SELECT event_id FROM event_tags WHERE tag IN (${placeholders}))`;
        params.push(...tagList);
      }

      return { sql, params, col };
      };

      const buildRemoteQueryBase = (): { sql: string; params: unknown[] } => {
      let sql = `${REMOTE_EVENT_SELECT} WHERE 1=1`;
      const params: unknown[] = [];
      const remoteVisibility = buildRemoteVisibilityFilter(user?.id);

      sql += ` AND ${remoteVisibility.sql}`;
      params.push(...remoteVisibility.params);

      if (isCalendarScope) {
        sql += ` AND re.uri IN (
          SELECT event_uri FROM event_rsvps WHERE account_id = ? AND status IN ('going','maybe')
        )`;
        params.push(user!.id);
        } else if (isMineScope) {
          sql += ` AND (
            re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
            OR re.uri IN (SELECT event_uri FROM reposts WHERE account_id = ?)
            OR re.actor_uri IN (SELECT source_actor_uri FROM auto_reposts WHERE account_id = ?)
            OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?)
          )`;
          params.push(user!.id, user!.id, user!.id, user!.id);
        }

      const df = appendDateRangeFilters({ instantColumn: "re.start_at_utc", dateColumn: "re.start_on" }, from, to);
      sql += df.sql;
      params.push(...df.params);

      if (q) {
        sql += " AND (re.title LIKE ? OR re.description LIKE ?)";
        params.push(`%${q}%`, `%${q}%`);
      }

      const tagFilter = buildRemoteTagFilter(tagList);
      sql += tagFilter.sql;
      params.push(...tagFilter.params);
      return { sql, params };
      };

      let events: Record<string, unknown>[] = [];
      let nextCursor: string | null = null;

      if (source === "local") {
      const fetchLocal: MergedFetcher = (after, fetchLimit) => {
        const { sql, params, col } = buildLocalQueryBase();
        let pagedSql = sql;
        if (after) {
          pagedSql += ` AND (${col}.start_at_utc > ? OR (${col}.start_at_utc = ? AND ${col}.id > ?))`;
          params.push(after.startAtUtc, after.startAtUtc, after.id);
        }
        pagedSql += ` GROUP BY ${col}.id ORDER BY ${col}.start_at_utc ASC, ${col}.id ASC LIMIT ?`;
        params.push(fetchLimit);
        const rows = db.prepare(pagedSql).all(...params) as Record<string, unknown>[];
        return rows.map((r) => ({ ...formatEvent(r), source: "local" }));
      };

      const paged = paginateMergedFromFetchers({
        limit,
        offset,
        cursor,
        fetchChunkSize: limit + 1,
        fetchLocal,
      });
      events = paged.page;
      nextCursor = paged.nextCursor;
      } else if (source === "remote") {
      const fetchRemote: MergedFetcher = (after, fetchLimit) => {
        const { sql, params } = buildRemoteQueryBase();
        let pagedSql = sql;
        if (after) {
          pagedSql += " AND (re.start_at_utc > ? OR (re.start_at_utc = ? AND re.uri > ?))";
          params.push(after.startAtUtc, after.startAtUtc, after.id);
        }
        pagedSql += " ORDER BY re.start_at_utc ASC, re.uri ASC LIMIT ?";
        params.push(fetchLimit);
        const rows = db.prepare(pagedSql).all(...params) as Record<string, unknown>[];
        return rows.map(formatRemoteEvent);
      };

      const paged = paginateMergedFromFetchers({
        limit,
        offset,
        cursor,
        fetchChunkSize: limit + 1,
        fetchRemote,
      });
      events = paged.page;
      nextCursor = paged.nextCursor;
      } else {
      const fetchLocal: MergedFetcher = (after, fetchLimit) => {
        const { sql, params, col } = buildLocalQueryBase();
        let pagedSql = sql;
        if (after) {
          pagedSql += ` AND (${col}.start_at_utc > ? OR (${col}.start_at_utc = ? AND ${col}.id > ?))`;
          params.push(after.startAtUtc, after.startAtUtc, after.id);
        }
        pagedSql += ` GROUP BY ${col}.id ORDER BY ${col}.start_at_utc ASC, ${col}.id ASC LIMIT ?`;
        params.push(fetchLimit);
        const rows = db.prepare(pagedSql).all(...params) as Record<string, unknown>[];
        return rows.map((r) => ({ ...formatEvent(r), source: "local" }));
      };

      const fetchRemote: MergedFetcher = (after, fetchLimit) => {
        const { sql, params } = buildRemoteQueryBase();
        let pagedSql = sql;
        if (after) {
          pagedSql += " AND (re.start_at_utc > ? OR (re.start_at_utc = ? AND re.uri > ?))";
          params.push(after.startAtUtc, after.startAtUtc, after.id);
        }
        pagedSql += " ORDER BY re.start_at_utc ASC, re.uri ASC LIMIT ?";
        params.push(fetchLimit);
        const rows = db.prepare(pagedSql).all(...params) as Record<string, unknown>[];
        return rows.map(formatRemoteEvent);
      };

      const paged = paginateMergedFromFetchers({
        limit,
        offset,
        cursor,
        fetchChunkSize: limit + 1,
        fetchLocal,
        fetchRemote,
      });
      events = paged.page;
      nextCursor = paged.nextCursor;
      }

      if (user) events = attachUserContext(events, user.id);

      return c.json({ events, nextCursor });
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      if (error instanceof PaginationParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // ─── POST /rsvp ────────────────────────────────────────────────────────

  router.get("/timeline", requireAuth(), (c) => {
    const user = c.get("user")!;
    const from = c.req.query("from") || new Date().toISOString();
    const to = c.req.query("to");
    const cursor = c.req.query("cursor");
    try {
      validateMergedCursorParam(cursor);
      const { limit, offset } = parseLimitOffset(c, { defaultLimit: 50, maxLimit: 200 });

      const fetchLocal: MergedFetcher = (after, fetchLimit) => {
      const baseUrl = getBaseUrl();
      const feed = buildFeedQuery({ userId: user.id, baseUrl });
      let sql = feed.sql;
      const params = [...feed.params];

      const df = appendDateRangeFilters(
        { instantColumn: "combined.start_at_utc", dateColumn: "combined.start_on" },
        from,
        to,
      );
      sql += df.sql;
      params.push(...df.params);

      sql = appendVisibleLocalEventFilter(sql, "combined");

      if (after) {
        sql += " AND (combined.start_at_utc > ? OR (combined.start_at_utc = ? AND combined.id > ?))";
        params.push(after.startAtUtc, after.startAtUtc, after.id);
      }
      sql += " GROUP BY combined.id ORDER BY combined.start_at_utc ASC, combined.id ASC LIMIT ?";
      params.push(fetchLimit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map((r) => ({ ...formatEvent(r), source: "local" }));
      };

      const fetchRemote: MergedFetcher = (after, fetchLimit) => {
      const remoteVisibility = buildRemoteVisibilityFilter(user.id);
      let sql = `${REMOTE_EVENT_SELECT}
        WHERE (
            re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
            OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?)
          )
          AND ${remoteVisibility.sql}`;
      const params: unknown[] = [user.id, user.id, ...remoteVisibility.params];

      const df = appendDateRangeFilters({ instantColumn: "re.start_at_utc", dateColumn: "re.start_on" }, from, to);
      sql += df.sql;
      params.push(...df.params);

      if (after) {
        sql += " AND (re.start_at_utc > ? OR (re.start_at_utc = ? AND re.uri > ?))";
        params.push(after.startAtUtc, after.startAtUtc, after.id);
      }
      sql += " ORDER BY re.start_at_utc ASC, re.uri ASC LIMIT ?";
      params.push(fetchLimit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map(formatRemoteEvent);
      };

      const paged = paginateMergedFromFetchers({
        limit,
        offset,
        cursor,
        fetchChunkSize: limit + 1,
        fetchLocal,
        fetchRemote,
      });
      let events = paged.page;

      // Timeline only attaches RSVPs (no repost flags)
      const uris = events.map((e) => e.id as string);
      const rsvps = getUserRsvps(user.id, uris);
      events = events.map((e) => ({ ...e, rsvpStatus: rsvps.get(e.id as string) || null }));

      return c.json({ events, nextCursor: paged.nextCursor });
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      if (error instanceof PaginationParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // ─── POST /sync — full replace for scraper accounts ─────────────────────

  router.get("/by-slug/:username/:slug", (c) => {
    const username = c.req.param("username");
    const slug = c.req.param("slug");
    const currentUser = c.get("user");
    const remoteVisibility = buildRemoteVisibilityFilter(currentUser?.id);

    const remoteHandle = parseRemoteHandle(username);
    if (remoteHandle) {
      const { localPart, domain } = remoteHandle;
      const remoteRow = db
        .prepare(`${REMOTE_EVENT_SELECT} WHERE ra.preferred_username = ? AND ra.domain = ? AND re.slug = ? AND ${remoteVisibility.sql}`)
        .get(localPart, domain, slug, ...remoteVisibility.params) as Record<string, unknown> | undefined;
      if (!remoteRow) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
      const event = formatRemoteEvent(remoteRow);
      if (currentUser) attachSingleEventContext(event, remoteRow.uri as string, currentUser.id);
      return c.json(event);
    }

    const event = fetchLocalEvent("a.username = ? AND e.slug = ?", [username, slug], currentUser, { allowAdminFlaggedModerationAccess: true });
    if (!event) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    return c.json(event);
  });

  router.get("/resolve", async (c) => {
    const locale = getLocale(c);
    const uri = c.req.query("uri")?.trim();
    if (!uri) return c.json({ error: t(locale, "events.resolve_uri_required") }, 400);

    const wantsHtml = (c.req.header("accept") || "").includes("text/html");

    let normalizedUri: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
      normalizedUri = parsed.toString();
    } catch {
      return c.json({ error: t(locale, "events.resolve_invalid_uri") }, 400);
    }

    const currentUser = c.get("user") as { id: string } | undefined;
    const remoteVisibility = buildRemoteVisibilityFilter(currentUser?.id);

    const existing = db
      .prepare(
        `SELECT re.*, ra.preferred_username, ra.domain
         FROM remote_events re
         JOIN remote_actors ra ON ra.uri = re.actor_uri
         WHERE re.uri = ?
           AND ${remoteVisibility.sql}`
      )
      .get(normalizedUri, ...remoteVisibility.params) as Record<string, unknown> | undefined;
    if (existing?.preferred_username && existing.domain) {
      const resolvedSlug = (existing.slug as string | null) || uniqueRemoteEventSlug(
        db,
        existing.actor_uri as string,
        (existing.title as string) || "event",
      );
      if (!existing.slug) {
        db.prepare("UPDATE remote_events SET slug = ? WHERE uri = ?").run(resolvedSlug, existing.uri as string);
      }
      const path = `/@${existing.preferred_username}@${existing.domain}/${resolvedSlug}`;
      if (wantsHtml) return c.redirect(path, 302);
      return c.json({ path, event: formatRemoteEvent({ ...existing, slug: resolvedSlug }) });
    }

    try {
      await validateFederationUrl(normalizedUri);
    } catch {
      return c.json({ error: t(locale, "federation.private_address_not_allowed") }, 400);
    }

    try {
      const object = await fetchAP(normalizedUri) as Record<string, unknown>;
      const objectType = object.type;
      if (objectType !== "Event") return c.json({ error: t(locale, "events.resolve_not_event") }, 400);
      const title = object.name ?? object.title;
      const startDate = object.startTime ?? object.startDate;
      if (!title || !startDate || !object.id) {
        return c.json({ error: t(locale, "events.resolve_missing_required_fields") }, 400);
      }

      const attributedTo = object.attributedTo;
      const actorUri = typeof attributedTo === "string"
        ? attributedTo
        : Array.isArray(attributedTo)
          ? attributedTo.find((v): v is string => typeof v === "string")
          : undefined;
      if (!actorUri) return c.json({ error: t(locale, "events.resolve_missing_actor") }, 400);

      const actor = await resolveRemoteActor(db, actorUri, true);
      if (!actor) return c.json({ error: t(locale, "federation.could_not_resolve_actor") }, 404);

      const temporal = normalizeApTemporal(object);
      if (!temporal) return c.json({ error: t(locale, "events.invalid_datetime") }, 400);
      const hasAddressing = Object.hasOwn(object, "to") || Object.hasOwn(object, "cc");
      const fetchedVisibility = hasAddressing
        ? deriveVisibilityFromActivityPubAddressing(object, {
          actorFollowersUrl: actor.followers_url,
        })
        : "public";
      if (!canViewRemoteByVisibility(db, fetchedVisibility, actor.uri, currentUser?.id)) {
        return c.json({ error: t(locale, "common.forbidden") }, 403);
      }
      const stored = upsertRemoteEvent(db, object, actor.uri, { temporal });
      const path = `/@${actor.preferred_username}@${actor.domain}/${stored.slug}`;
      const row = db
        .prepare(`${REMOTE_EVENT_SELECT} WHERE re.uri = ? AND ${remoteVisibility.sql}`)
        .get(stored.uri, ...remoteVisibility.params) as Record<string, unknown> | undefined;

      if (wantsHtml) return c.redirect(path, 302);
      return c.json({ path, event: row ? formatRemoteEvent(row) : null });
    } catch (err) {
      const msg = toErrorMessage(err, "Failed to fetch remote event");
      return c.json({ error: t(locale, "events.resolve_fetch_failed", { error: msg }) }, 502);
    }
  });

  // ─── GET /:id ───────────────────────────────────────────────────────────

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    const currentUser = c.get("user");
    const eventUri = resolveEventUri(id);

    // Try local first
    const localEvent = fetchLocalEvent("e.id = ?", [id], currentUser, { allowAdminFlaggedModerationAccess: true });
    if (localEvent) return c.json(localEvent);

    // Fall back to remote events if URI looks like a URL
    if (eventUri.startsWith("http://") || eventUri.startsWith("https://")) {
      const remoteVisibility = buildRemoteVisibilityFilter(currentUser?.id);
      const remoteRow = db
        .prepare(`${REMOTE_EVENT_SELECT} WHERE re.uri = ? AND ${remoteVisibility.sql}`)
        .get(eventUri, ...remoteVisibility.params) as Record<string, unknown> | undefined;

      if (remoteRow) {
        const event = formatRemoteEvent(remoteRow);
        if (currentUser) {
          const rsvpRow = db
            .prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
            .get(currentUser.id, eventUri) as { status: string } | undefined;
          (event as Record<string, unknown>).rsvpStatus = rsvpRow?.status || null;
        }
        return c.json(event);
      }
    }

    return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
  });

  // ─── POST / — create event ─────────────────────────────────────────────
}
