import type { Hono } from "hono";
import type { DB } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { getLocale, t } from "../../lib/i18n.js";
import { parseJsonBody } from "../../lib/request-body.js";
import { listActingAccounts } from "../../lib/identities.js";
import { ActorSelectionPayloadError, applyLocalActorSelection, buildActorSelectionPlan, isDesiredAccountIdsAllowed, readActorSelectionPayload, summarizeActorSelection } from "../../lib/actor-selection.js";

export function registerEventSocialRoutes(router: Hono, db: DB): void {
  router.post("/rsvp", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const parsed = await parseJsonBody<{ eventUri: string; status: string | null }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    if (!body.eventUri) return c.json({ error: t(getLocale(c), "events.event_uri_required") }, 400);

    if (body.status === null || body.status === undefined || body.status === "") {
      db.prepare("DELETE FROM event_rsvps WHERE account_id = ? AND event_uri = ?").run(user.id, body.eventUri);
      return c.json({ ok: true, status: null });
    }

    if (!["going", "maybe"].includes(body.status)) {
      return c.json({ error: t(getLocale(c), "events.status_invalid") }, 400);
    }

    const localEvent = db.prepare("SELECT id FROM events WHERE id = ?").get(body.eventUri);
    const remoteEvent = !localEvent
      ? db.prepare("SELECT uri FROM remote_events WHERE uri = ?").get(body.eventUri)
      : null;
    if (!localEvent && !remoteEvent) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);

    db.prepare(
      `INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, ?)
       ON CONFLICT(account_id, event_uri) DO UPDATE SET status = excluded.status`
    ).run(user.id, body.eventUri, body.status);

    return c.json({ ok: true, status: body.status });
  });

  // ─── GET /timeline ─────────────────────────────────────────────────────

  router.post("/:id/repost", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const event = db.prepare("SELECT id, account_id, visibility FROM events WHERE id = ?").get(id) as
      | { id: string; account_id: string; visibility: string }
      | undefined;
    if (!event) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);
    if (event.visibility !== "public" && event.visibility !== "unlisted") {
      return c.json({ error: t(getLocale(c), "events.repost_public_unlisted_only") }, 403);
    }

    let body: { desiredAccountIds?: string[] };
    try {
      body = await readActorSelectionPayload(c);
    } catch (err) {
      if (err instanceof ActorSelectionPayloadError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
    if (!body.desiredAccountIds) {
      if (event.account_id === user.id) return c.json({ error: t(getLocale(c), "events.cannot_repost_own") }, 400);
      db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id) VALUES (?, ?)").run(user.id, id);
      return c.json({ ok: true, reposted: true });
    }

    const acting = listActingAccounts(db, user.id, "editor");
    const actingIds = acting.map((a) => a.id);
    if (!isDesiredAccountIdsAllowed(body.desiredAccountIds, actingIds)) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const activeRows = db
      .prepare("SELECT account_id FROM reposts WHERE event_id = ?")
      .all(id) as Array<{ account_id: string }>;
    const plan = buildActorSelectionPlan({
      actingAccountIds: actingIds,
      desiredAccountIds: body.desiredAccountIds,
      activeAccountIds: activeRows.map((r) => r.account_id),
      validateTransition: ({ accountId, after }) => {
        if (accountId === event.account_id && after) return t(getLocale(c), "events.cannot_repost_own");
        return null;
      },
    });

    const { operationId, results } = applyLocalActorSelection({
      db,
      operation: {
        actionKind: "event_repost",
        targetType: "event",
        targetId: id,
        initiatedByAccountId: user.id,
      },
      plan,
      applyAdd: (accountId) => {
        db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id) VALUES (?, ?)").run(accountId, id);
      },
      applyRemove: (accountId) => {
        db.prepare("DELETE FROM reposts WHERE account_id = ? AND event_id = ?").run(accountId, id);
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

  // ─── DELETE /:id/repost ─────────────────────────────────────────────────

  router.delete("/:id/repost", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    db.prepare("DELETE FROM reposts WHERE account_id = ? AND event_id = ?").run(user.id, id);
    return c.json({ ok: true, reposted: false });
  });

  router.get("/:id/repost-actors", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const event = db.prepare("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | undefined;
    if (!event) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);

    const acting = listActingAccounts(db, user.id, "editor");
    const allowed = new Set(acting.map((a) => a.id));
    const activeRows = db
      .prepare("SELECT account_id FROM reposts WHERE event_id = ?")
      .all(id) as Array<{ account_id: string }>;
    const activeAccountIds = activeRows.map((r) => r.account_id).filter((accountId) => allowed.has(accountId));
    return c.json({ activeAccountIds, actorIds: Array.from(allowed) });
  });

  // ─── GET /by-slug/:username/:slug ───────────────────────────────────────
}
