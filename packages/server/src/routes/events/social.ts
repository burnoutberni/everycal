import type { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../../db.js";
import { ensureKeyPairForAccount } from "../../lib/account-keys.js";
import { enqueueOutboundDelivery, resolveRemoteActor } from "../../lib/federation.js";
import { mapLocalRsvpStateToActivityPubType, type LocalRsvpState } from "../../lib/activitypub-rsvp.js";
import { createActivityId } from "../../lib/activity-ids.js";
import { requireAuth } from "../../middleware/auth.js";
import { getLocale, t } from "../../lib/i18n.js";
import { parseJsonBody } from "../../lib/request-body.js";
import { listActingAccounts } from "../../lib/identities.js";
import { ActorSelectionPayloadError, applyLocalActorSelection, buildActorSelectionPlan, isDesiredAccountIdsAllowed, readActorSelectionPayload, summarizeActorSelection } from "../../lib/actor-selection.js";
import { buildActorUrl, buildUrl, getBaseUrl } from "../../lib/base-url.js";
import { resolveEventUri } from "./shared.js";

function buildLocalEventUri(eventId: string): string {
  return buildUrl(getBaseUrl(), "events", eventId);
}

function resolveLocalEventId(input: string): string | null {
  const baseUrl = getBaseUrl();
  const eventUri = resolveEventUri(input);
  if (!eventUri.startsWith("http://") && !eventUri.startsWith("https://")) {
    return eventUri;
  }

  try {
    const parsedEventUrl = new URL(eventUri);
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedEventUrl.origin !== parsedBaseUrl.origin) return null;
    const segments = parsedEventUrl.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0] !== "events") return null;
    return decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
}

function deleteRepostsForEvent(db: DB, accountId: string, eventUri: string): number {
  return db.prepare("DELETE FROM reposts WHERE account_id = ? AND event_uri = ?").run(accountId, eventUri).changes;
}

async function enqueueOutboundRsvpIfNeeded(
  db: DB,
  params: {
    accountId: string;
    username: string;
    eventUri: string;
    remoteEventActorUri: string;
    nextStatus: LocalRsvpState;
  },
): Promise<void> {
  if (!ensureKeyPairForAccount(db, params.accountId)) return;
  const remoteActor = await resolveRemoteActor(db, params.remoteEventActorUri);
  if (!remoteActor?.inbox) {
    console.log(`[Federation] Skipping RSVP delivery; could not resolve ${params.remoteEventActorUri}`);
    return;
  }

  const actorUrl = buildActorUrl(params.username);
  const type = mapLocalRsvpStateToActivityPubType(params.nextStatus);
  const activityId = createActivityId(db, {
    actorUri: actorUrl,
    activityType: type,
    objectUri: params.eventUri,
    logicalKey: `rsvp:${params.accountId}:${params.eventUri}:${Date.now()}:${nanoid(10)}`,
  });
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: activityId,
    type,
    actor: actorUrl,
    object: params.eventUri,
    to: [params.remoteEventActorUri],
    cc: [],
  };

  enqueueOutboundDelivery(db, {
    destinationInbox: remoteActor.inbox,
    senderAccountId: params.accountId,
    senderActorUri: actorUrl,
    activity,
  });
}


export function registerEventSocialRoutes(router: Hono, db: DB): void {
  router.post("/rsvp", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const parsed = await parseJsonBody<{ eventUri: string; status: string | null }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    if (!body.eventUri) return c.json({ error: t(getLocale(c), "events.event_uri_required") }, 400);

    const rawNextStatus = (body.status === null || body.status === undefined || body.status === "")
      ? null
      : body.status;

    if (rawNextStatus !== null && !["going", "maybe"].includes(rawNextStatus)) {
      return c.json({ error: t(getLocale(c), "events.status_invalid") }, 400);
    }
    const nextStatus = rawNextStatus as LocalRsvpState;

    const localEvent = db.prepare("SELECT id FROM events WHERE id = ?").get(body.eventUri);
    const remoteEvent = !localEvent
      ? db.prepare("SELECT uri, actor_uri, visibility FROM remote_events WHERE uri = ?").get(body.eventUri) as
        | { uri: string; actor_uri: string; visibility: string }
        | undefined
      : null;
    if (!localEvent && !remoteEvent) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);

    if (remoteEvent) {
      if (remoteEvent.visibility === "private") {
        return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
      }
      if (remoteEvent.visibility === "followers_only") {
        const follows = db
          .prepare("SELECT 1 FROM remote_following WHERE account_id = ? AND actor_uri = ?")
          .get(user.id, remoteEvent.actor_uri);
        if (!follows) return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
      }
    }

    const previous = db.prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
      .get(user.id, body.eventUri) as { status: string } | undefined;
    const previousStatus = (previous?.status ?? null) as LocalRsvpState;
    const isNoop = previousStatus === nextStatus;

    if (nextStatus === null) {
      if (!isNoop) {
        db.prepare("DELETE FROM event_rsvps WHERE account_id = ? AND event_uri = ?").run(user.id, body.eventUri);
      }
    } else if (!isNoop) {
      db.prepare(
        `INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, ?)
         ON CONFLICT(account_id, event_uri) DO UPDATE SET status = excluded.status`
      ).run(user.id, body.eventUri, nextStatus);
    }

    if (remoteEvent && !isNoop) {
      await enqueueOutboundRsvpIfNeeded(db, {
        accountId: user.id,
        username: user.username,
        eventUri: remoteEvent.uri,
        remoteEventActorUri: remoteEvent.actor_uri,
        nextStatus,
      });
    }

    return c.json({ ok: true, status: nextStatus });
  });

  // ─── GET /timeline ─────────────────────────────────────────────────────

  router.post("/:id/repost", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const eventUri = resolveEventUri(id);
    const localEventId = resolveLocalEventId(id);

    const event = localEventId
      ? db.prepare("SELECT id, account_id, visibility FROM events WHERE id = ?").get(localEventId) as
        | { id: string; account_id: string; visibility: string }
        | undefined
      : undefined;
    const remoteEvent = !event
      ? db.prepare("SELECT uri, actor_uri, visibility FROM remote_events WHERE uri = ?").get(eventUri) as
        | { uri: string; actor_uri: string; visibility: string }
        | undefined
      : undefined;
    if (!event && !remoteEvent) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);

    const canView = event
      ? event.visibility === "public"
        || event.visibility === "unlisted"
        || event.account_id === user.id
        || (event.visibility === "followers_only" && !!db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?").get(user.id, event.account_id))
      : remoteEvent!.visibility === "public"
        || remoteEvent!.visibility === "unlisted"
        || (remoteEvent!.visibility === "followers_only" && !!db.prepare("SELECT 1 FROM remote_following WHERE account_id = ? AND actor_uri = ?").get(user.id, remoteEvent!.actor_uri));
    if (!canView) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }
    const repostTargetUri = event ? buildLocalEventUri(event.id) : remoteEvent!.uri;
    const repostSourceActorUri = event
      ? buildActorUrl((db.prepare("SELECT username FROM accounts WHERE id = ?").get(event.account_id) as { username: string }).username)
      : remoteEvent!.actor_uri;

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
      if (event?.account_id === user.id) return c.json({ error: t(getLocale(c), "events.cannot_repost_own") }, 400);
      db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
        user.id,
        event?.id ?? null,
        repostTargetUri,
        repostSourceActorUri,
      );
      return c.json({ ok: true, reposted: true });
    }

    const acting = listActingAccounts(db, user.id, "editor");
    const actingIds = acting.map((a) => a.id);
    if (!isDesiredAccountIdsAllowed(body.desiredAccountIds, actingIds)) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const activeRows = db
      .prepare("SELECT DISTINCT account_id FROM reposts WHERE event_uri = ?")
      .all(repostTargetUri) as Array<{ account_id: string }>;
    const plan = buildActorSelectionPlan({
      actingAccountIds: actingIds,
      desiredAccountIds: body.desiredAccountIds,
      activeAccountIds: activeRows.map((r) => r.account_id),
      validateTransition: ({ accountId, after }) => {
        if (event && accountId === event.account_id && after) return t(getLocale(c), "events.cannot_repost_own");
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
        db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
          accountId,
          event?.id ?? null,
          repostTargetUri,
          repostSourceActorUri,
        );
      },
      applyRemove: (accountId) => {
        deleteRepostsForEvent(db, accountId, repostTargetUri);
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
    const eventUri = resolveEventUri(id);
    const localEventId = resolveLocalEventId(id);
    const localEvent = localEventId
      ? db.prepare("SELECT id FROM events WHERE id = ?").get(localEventId) as { id: string } | undefined
      : undefined;
    const deleteTargetUri = localEvent ? buildLocalEventUri(localEvent.id) : eventUri;
    const removed = deleteRepostsForEvent(db, user.id, deleteTargetUri) > 0;
    return c.json({ ok: true, reposted: false, removed });
  });

  router.get("/:id/repost-actors", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const eventUri = resolveEventUri(id);
    const localEventId = resolveLocalEventId(id);
    const event = localEventId
      ? db.prepare("SELECT id FROM events WHERE id = ?").get(localEventId) as { id: string } | undefined
      : undefined;
    const remoteEvent = !event
      ? db.prepare("SELECT uri FROM remote_events WHERE uri = ?").get(eventUri) as { uri: string } | undefined
      : undefined;
    if (!event && !remoteEvent) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);

    const acting = listActingAccounts(db, user.id, "editor");
    const allowed = new Set(acting.map((a) => a.id));
    const repostLookupUri = event ? buildLocalEventUri(event.id) : remoteEvent!.uri;
    const activeRows = db.prepare("SELECT account_id FROM reposts WHERE event_uri = ?").all(repostLookupUri) as Array<{ account_id: string }>;
    const activeAccountIds = activeRows.map((r) => r.account_id).filter((accountId) => allowed.has(accountId));
    return c.json({ activeAccountIds, actorIds: Array.from(allowed) });
  });

  // ─── GET /by-slug/:username/:slug ───────────────────────────────────────
}
