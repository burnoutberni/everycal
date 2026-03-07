import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { toActivityPubEvent, toICal, type EveryCalEvent } from "@everycal/core";

export interface UnifiedAccount {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  passwordHash: string | null;
}

export interface UnifiedEvent {
  id: string;
  accountId: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  visibility: "public" | "unlisted" | "followers_only" | "private";
}

export interface UnifiedIdentity {
  id: string;
  username: string;
  displayName: string | null;
  role: "owner" | "editor";
}

export interface UnifiedSession {
  token: string;
  accountId: string;
  expiresAt: string;
}

export interface UploadObject {
  body: BodyInit;
  contentType?: string;
}

export interface SavedLocation {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  usedAt: string;
}

export interface RemoteActorSummary {
  uri: string;
  username: string;
  displayName: string | null;
  domain: string;
  inbox: string | null;
  iconUrl?: string | null;
}

export interface RemoteEventSummary {
  uri: string;
  actorUri: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
}

export interface UnifiedStorage {
  getSession(token: string): Promise<UnifiedSession | null>;
  createSession(accountId: string): Promise<UnifiedSession>;
  deleteSession(token: string): Promise<void>;
  getAccountById(id: string): Promise<UnifiedAccount | null>;
  getAccountByUsername(username: string): Promise<UnifiedAccount | null>;
  createAccount(input: { username: string; displayName: string; passwordHash: string }): Promise<UnifiedAccount>;
  listEventsForAccount(accountId: string): Promise<UnifiedEvent[]>;
  createEvent(input: {
    accountId: string;
    title: string;
    description?: string;
    startDate: string;
    endDate?: string;
    visibility?: UnifiedEvent["visibility"];
  }): Promise<{ id: string }>;
  getEventById(id: string): Promise<UnifiedEvent | null>;
  listPublicEventsByUsername(username: string, limit: number): Promise<UnifiedEvent[]>;
  createIdentity(ownerAccountId: string, input: { username: string; displayName: string }): Promise<UnifiedIdentity>;
  listIdentitiesForMember(memberAccountId: string): Promise<UnifiedIdentity[]>;
  addRemoteFollow(accountId: string, actorUri: string, inbox: string): Promise<void>;
  removeRemoteFollow(accountId: string, actorUri: string): Promise<void>;
  listFollowersByUsername(username: string): Promise<UnifiedAccount[]>;
  listRemoteFollowerActorUrisByUsername(username: string): Promise<string[]>;
  listFollowingByUsername(username: string): Promise<UnifiedAccount[]>;
  listSavedLocations(accountId: string): Promise<SavedLocation[]>;
  saveLocation(accountId: string, loc: { name: string; address?: string; latitude?: number; longitude?: number }): Promise<void>;
  deleteLocation(accountId: string, id: number): Promise<void>;
  listRemoteActors(params?: { domain?: string; limit?: number }): Promise<RemoteActorSummary[]>;
  searchRemoteActors(query: string): Promise<RemoteActorSummary[]>;
  listFollowedRemoteActors(accountId: string): Promise<RemoteActorSummary[]>;
  upsertRemoteActor(actor: RemoteActorSummary & { inbox: string }): Promise<void>;
  upsertRemoteEvent(event: RemoteEventSummary): Promise<void>;
  followRemoteActor(accountId: string, actor: RemoteActorSummary & { inbox: string }): Promise<void>;
  unfollowRemoteActor(accountId: string, actorUri: string): Promise<void>;
  listRemoteEvents(params?: { actor?: string; from?: string; limit?: number; offset?: number }): Promise<RemoteEventSummary[]>;
  putUpload(blob: { key: string; contentType: string; body: ArrayBuffer }): Promise<string>;
  getUpload(key: string): Promise<UploadObject | null>;
}

type InboxActivity = {
  type?: string;
  actor?: string;
  inbox?: string;
  object?: string | {
    id?: string;
    type?: string;
    actor?: string;
    object?: string | { id?: string };
  };
};

export type InboxVerificationResult = { ok: true } | { ok: false; status?: number; error?: string };


export type DeliveryResult = { ok: true; status?: number } | { ok: false; status?: number; error?: string };

export type SyncResult = {
  actor: (RemoteActorSummary & { inbox: string }) | null;
  eventsSynced: number;
};

export interface UnifiedAppDeps {
  storage: UnifiedStorage;
  baseUrl: string;
  sessionCookieName: string;
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, encodedHash: string | null): Promise<boolean>;
  verifyInboxRequest?(input: { request: Request; activity: InboxActivity }): Promise<InboxVerificationResult>;
  deliverActivity?(input: { inbox: string; activity: Record<string, unknown>; actorKeyId: string }): Promise<DeliveryResult>;
  syncRemoteActorAndEvents?(actorUri: string): Promise<SyncResult>;
}

type Variables = { accountId: string | null };

const AP_CONTENT_TYPE = "application/activity+json; charset=utf-8";
const AP_ACCEPT_TOKENS = ["application/activity+json", "application/ld+json"];

function isActivityPubRequest(acceptHeader: string): boolean {
  const accept = acceptHeader.toLowerCase();
  return AP_ACCEPT_TOKENS.some((token) => accept.includes(token));
}

function normalizeHandle(input: string): string {
  return input.trim().toLowerCase().replace(/^@+/, "");
}


function resolveLocalUsernameFromActorUri(actorUri: string, baseUrl: string): string | null {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  if (!actorUri.startsWith(`${normalizedBase}/users/`)) return null;
  const remainder = actorUri.slice(`${normalizedBase}/users/`.length);
  const username = remainder.split("/")[0]?.trim();
  return username ? normalizeHandle(username) : null;
}

function resolveFollowTargetUsername(activity: InboxActivity, baseUrl: string): string | null {
  if (activity.type !== "Follow") return null;
  const object = activity.object;
  if (typeof object === "string") return resolveLocalUsernameFromActorUri(object, baseUrl);
  if (object && typeof object.id === "string") return resolveLocalUsernameFromActorUri(object.id, baseUrl);
  return null;
}

function resolveUndoTargetUsername(activity: InboxActivity, baseUrl: string): string | null {
  if (activity.type !== "Undo") return null;
  const undoObject = activity.object;
  if (!undoObject || typeof undoObject === "string") return null;
  if (undoObject.type !== "Follow") return null;
  const followed = undoObject.object;
  if (typeof followed === "string") return resolveLocalUsernameFromActorUri(followed, baseUrl);
  if (followed && typeof followed.id === "string") return resolveLocalUsernameFromActorUri(followed.id, baseUrl);
  return null;
}

export function createUnifiedApp(deps: UnifiedAppDeps): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", async (c, next) => {
    const token = getCookie(c, deps.sessionCookieName);
    if (!token) {
      c.set("accountId", null);
      await next();
      return;
    }
    const session = await deps.storage.getSession(token);
    c.set("accountId", session?.accountId ?? null);
    await next();
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/api/v1/bootstrap", async (c) => {
    const accountId = c.get("accountId");
    const account = accountId ? await deps.storage.getAccountById(accountId) : null;
    return c.json({ mode: "unified", authenticated: Boolean(account), account });
  });

  app.post("/api/v1/auth/register", async (c) => {
    const body = await c.req.json<{ username: string; displayName?: string; password: string }>();
    const username = normalizeHandle(body.username || "");
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return c.json({ error: "invalid_username" }, 400);
    if (!body.password || body.password.length < 8) return c.json({ error: "password_too_short" }, 400);

    const existing = await deps.storage.getAccountByUsername(username);
    if (existing) return c.json({ error: "username_taken" }, 409);

    const account = await deps.storage.createAccount({
      username,
      displayName: body.displayName?.trim() || username,
      passwordHash: await deps.hashPassword(body.password),
    });

    const session = await deps.storage.createSession(account.id);
    setCookie(c, deps.sessionCookieName, session.token, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 14,
    });

    return c.json({ user: account, expiresAt: session.expiresAt }, 201);
  });

  app.post("/api/v1/auth/login", async (c) => {
    const body = await c.req.json<{ username: string; password: string }>();
    const account = await deps.storage.getAccountByUsername(normalizeHandle(body.username || ""));
    if (!account) return c.json({ error: "invalid_credentials" }, 401);
    const ok = await deps.verifyPassword(body.password || "", account.passwordHash);
    if (!ok) return c.json({ error: "invalid_credentials" }, 401);
    const session = await deps.storage.createSession(account.id);
    setCookie(c, deps.sessionCookieName, session.token, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 14,
    });
    return c.json({
      user: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
      },
      expiresAt: session.expiresAt,
    });
  });

  app.post("/api/v1/auth/logout", async (c) => {
    const token = getCookie(c, deps.sessionCookieName);
    if (token) await deps.storage.deleteSession(token);
    deleteCookie(c, deps.sessionCookieName, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/v1/auth/me", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const account = await deps.storage.getAccountById(accountId);
    if (!account) return c.json({ error: "unauthorized" }, 401);
    return c.json({ user: account });
  });

  app.get("/api/v1/events", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    return c.json({ events: await deps.storage.listEventsForAccount(accountId) });
  });

  app.post("/api/v1/events", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);

    const body = await c.req.json<{
      title: string;
      description?: string;
      startDate: string;
      endDate?: string;
      visibility?: UnifiedEvent["visibility"];
    }>();
    if (!body.title || !body.startDate) return c.json({ error: "missing_required_fields" }, 400);

    const created = await deps.storage.createEvent({
      accountId,
      title: body.title,
      description: body.description,
      startDate: body.startDate,
      endDate: body.endDate,
      visibility: body.visibility,
    });
    return c.json({ event: await deps.storage.getEventById(created.id) }, 201);
  });

  app.get("/api/v1/events/:username", async (c) => {
    const events = await deps.storage.listPublicEventsByUsername(c.req.param("username"), 100);
    return c.json({ events });
  });

  app.get("/api/v1/identities", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    return c.json({ identities: await deps.storage.listIdentitiesForMember(accountId) });
  });

  app.post("/api/v1/identities", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ username: string; displayName?: string }>();
    const username = normalizeHandle(body.username || "");
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return c.json({ error: "invalid_username" }, 400);
    const identity = await deps.storage.createIdentity(accountId, {
      username,
      displayName: body.displayName || username,
    });
    return c.json({ identity }, 201);
  });


  app.get("/api/v1/users/:username/followers", async (c) => {
    const users = await deps.storage.listFollowersByUsername(normalizeHandle(c.req.param("username")));
    return c.json({ users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl })) });
  });

  app.get("/api/v1/users/:username/following", async (c) => {
    const users = await deps.storage.listFollowingByUsername(normalizeHandle(c.req.param("username")));
    return c.json({ users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl })) });
  });

  app.get("/api/v1/locations", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    return c.json(await deps.storage.listSavedLocations(accountId));
  });

  app.post("/api/v1/locations", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ name: string; address?: string; latitude?: number; longitude?: number }>();
    if (!body.name?.trim()) return c.json({ error: "name_required" }, 400);
    await deps.storage.saveLocation(accountId, body);
    return c.json({ ok: true });
  });

  app.delete("/api/v1/locations/:id", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid_id" }, 400);
    await deps.storage.deleteLocation(accountId, id);
    return c.json({ ok: true });
  });

  app.get("/api/v1/feeds/:username.ics", async (c) => {
    const username = c.req.param("username");
    const events = await deps.storage.listPublicEventsByUsername(username, 200);
    const vevents = events.map((event) => {
      const normalized: EveryCalEvent = {
        id: event.id,
        title: event.title,
        description: event.description ?? undefined,
        startDate: event.startDate,
        endDate: event.endDate ?? undefined,
        allDay: false,
        visibility: event.visibility,
        createdAt: event.startDate,
        updatedAt: event.startDate,
        url: `${deps.baseUrl}/events/${event.id}`,
      };
      return toICal(normalized);
    });

    c.header("content-type", "text/calendar; charset=utf-8");
    return c.body([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:-//EveryCal//${username}//EN`,
      `X-WR-CALNAME:${username}`,
      ...vevents,
      "END:VCALENDAR",
    ].join("\r\n"));
  });

  app.get("/api/v1/feeds/:username.json", async (c) => {
    return c.json({ events: await deps.storage.listPublicEventsByUsername(c.req.param("username"), 200) });
  });



  app.get("/api/v1/federation/search", async (c) => {
    const q = (c.req.query("q") || "").trim();
    if (q.length < 2) return c.json({ error: "query_too_short" }, 400);
    const actors = await deps.storage.searchRemoteActors(q);
    if (actors.length === 0) return c.json({ error: "actor_not_found" }, 404);
    return c.json({ actor: actors[0] });
  });

  app.post("/api/v1/federation/follow", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ actorUri?: string }>();
    if (!body.actorUri) return c.json({ error: "actor_uri_required" }, 400);

    if (deps.syncRemoteActorAndEvents) {
      const synced = await deps.syncRemoteActorAndEvents(body.actorUri);
      if (synced.actor) {
        await deps.storage.upsertRemoteActor(synced.actor);
      }
    }

    const actor = (await deps.storage.searchRemoteActors(body.actorUri)).find((a) => a.uri === body.actorUri)
      ?? (await deps.storage.listRemoteActors({ limit: 1000 })).find((a) => a.uri === body.actorUri);
    if (!actor || !actor.inbox) return c.json({ error: "actor_not_found" }, 404);
    await deps.storage.followRemoteActor(accountId, { ...actor, inbox: actor.inbox });

    let delivered = false;
    if (deps.deliverActivity) {
      const account = await deps.storage.getAccountById(accountId);
      if (account) {
        const actorUrl = `${deps.baseUrl}/users/${account.username}`;
        const followActivity = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${actorUrl}#follow-${Date.now()}`,
          type: "Follow",
          actor: actorUrl,
          object: body.actorUri,
        };
        const delivery = await deps.deliverActivity({ inbox: actor.inbox, activity: followActivity, actorKeyId: `${actorUrl}#main-key` });
        delivered = delivery.ok;
      }
    }

    return c.json({ ok: true, delivered });
  });

  app.post("/api/v1/federation/unfollow", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ actorUri?: string }>();
    if (!body.actorUri) return c.json({ error: "actor_uri_required" }, 400);

    const existing = (await deps.storage.listFollowedRemoteActors(accountId)).find((actor) => actor.uri === body.actorUri);

    let delivered = false;
    if (deps.deliverActivity && existing?.inbox) {
      const account = await deps.storage.getAccountById(accountId);
      if (account) {
        const actorUrl = `${deps.baseUrl}/users/${account.username}`;
        const followObject = {
          id: `${actorUrl}#follow-${Date.now()}`,
          type: "Follow",
          actor: actorUrl,
          object: body.actorUri,
        };
        const undoActivity = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${actorUrl}#undo-${Date.now()}`,
          type: "Undo",
          actor: actorUrl,
          object: followObject,
        };
        const delivery = await deps.deliverActivity({ inbox: existing.inbox, activity: undoActivity, actorKeyId: `${actorUrl}#main-key` });
        delivered = delivery.ok;
      }
    }

    await deps.storage.unfollowRemoteActor(accountId, body.actorUri);
    return c.json({ ok: true, delivered });
  });

  app.get("/api/v1/federation/following", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    const actors = await deps.storage.listFollowedRemoteActors(accountId);
    return c.json({ actors });
  });

  app.get("/api/v1/federation/actors", async (c) => {
    const domain = c.req.query("domain") || undefined;
    const limit = Number.parseInt(c.req.query("limit") || "20", 10);
    const actors = await deps.storage.listRemoteActors({ domain, limit: Number.isFinite(limit) ? limit : 20 });
    return c.json({ actors });
  });

  app.get("/api/v1/federation/remote-events", async (c) => {
    const actor = c.req.query("actor") || undefined;
    const from = c.req.query("from") || undefined;
    const limit = Number.parseInt(c.req.query("limit") || "50", 10);
    const offset = Number.parseInt(c.req.query("offset") || "0", 10);
    const events = await deps.storage.listRemoteEvents({
      actor,
      from,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return c.json({ events });
  });

  app.post("/api/v1/federation/sync", async (c) => {
    const accountId = c.get("accountId");
    if (!accountId) return c.json({ error: "unauthorized" }, 401);
    if (!deps.syncRemoteActorAndEvents) return c.json({ error: "sync_not_supported" }, 501);
    const body = await c.req.json<{ actorUri?: string }>();
    if (!body.actorUri) return c.json({ error: "actor_uri_required" }, 400);
    const result = await deps.syncRemoteActorAndEvents(body.actorUri);
    if (result.actor) await deps.storage.upsertRemoteActor(result.actor);
    return c.json({ ok: true, actor: result.actor, eventsSynced: result.eventsSynced });
  });

  app.put("/api/v1/uploads/:key", async (c) => {
    const key = c.req.param("key");
    const contentType = c.req.header("content-type") || "application/octet-stream";
    const url = await deps.storage.putUpload({ key, contentType, body: await c.req.arrayBuffer() });
    return c.json({ url });
  });

  app.get("/uploads/:key", async (c) => {
    const object = await deps.storage.getUpload(c.req.param("key"));
    if (!object) return c.notFound();
    if (object.contentType) c.header("Content-Type", object.contentType);
    return c.body(object.body);
  });


  app.get("/.well-known/nodeinfo", (c) => {
    return c.json({
      links: [
        { rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: `${deps.baseUrl}/nodeinfo/2.0` },
        { rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: `${deps.baseUrl}/nodeinfo/2.1` },
      ],
    });
  });

  app.get("/nodeinfo/:version", (c) => {
    const version = c.req.param("version");
    if (version !== "2.0" && version !== "2.1") return c.notFound();
    return c.json({
      version,
      software: { name: "everycal", version: "0.1.0" },
      protocols: ["activitypub"],
      services: { inbound: [], outbound: [] },
      openRegistrations: true,
      usage: { users: { total: 0, activeHalfyear: 0, activeMonth: 0 }, localPosts: 0, localComments: 0 },
      metadata: { runtime: "unified" },
    });
  });

  app.get("/.well-known/webfinger", async (c) => {
    const resource = c.req.query("resource") || "";
    const match = resource.match(/^acct:([^@]+)@/);
    if (!match) return c.json({ error: "invalid_resource" }, 400);
    const username = normalizeHandle(match[1]);
    const account = await deps.storage.getAccountByUsername(username);
    if (!account) return c.notFound();
    return c.json({
      subject: resource,
      links: [{ rel: "self", type: "application/activity+json", href: `${deps.baseUrl}/users/${username}` }],
    });
  });

  app.get("/users/:username", async (c) => {
    if (!isActivityPubRequest(c.req.header("accept") || "")) {
      return c.json({ error: "accept_activity_json" }, 406);
    }
    const username = normalizeHandle(c.req.param("username"));
    const account = await deps.storage.getAccountByUsername(username);
    if (!account) return c.notFound();
    const actorUrl = `${deps.baseUrl}/users/${username}`;
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: actorUrl,
      type: "Person",
      preferredUsername: username,
      name: account.displayName || username,
      inbox: `${actorUrl}/inbox`,
      outbox: `${actorUrl}/outbox`,
      followers: `${actorUrl}/followers`,
      following: `${actorUrl}/following`,
    }, 200, { "Content-Type": AP_CONTENT_TYPE });
  });

  app.get("/users/:username/outbox", async (c) => {
    if (!isActivityPubRequest(c.req.header("accept") || "")) {
      return c.json({ error: "accept_activity_json" }, 406);
    }
    const username = normalizeHandle(c.req.param("username"));
    const account = await deps.storage.getAccountByUsername(username);
    if (!account) return c.notFound();
    const events = await deps.storage.listPublicEventsByUsername(username, 40);
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "OrderedCollection",
      totalItems: events.length,
      orderedItems: events.map((event) => ({
        id: `${deps.baseUrl}/activities/create-${event.id}`,
        type: "Create",
        actor: `${deps.baseUrl}/users/${username}`,
        object: toActivityPubEvent({
          id: `${deps.baseUrl}/events/${event.id}`,
          title: event.title,
          description: event.description || "",
          startDate: event.startDate,
          endDate: event.endDate || undefined,
          allDay: false,
          visibility: event.visibility,
          createdAt: event.startDate,
          updatedAt: event.startDate,
          url: `${deps.baseUrl}/events/${event.id}`,
        }),
      })),
    }, 200, { "Content-Type": AP_CONTENT_TYPE });
  });


  app.get("/users/:username/followers", async (c) => {
    if (!isActivityPubRequest(c.req.header("accept") || "")) {
      return c.json({ error: "accept_activity_json" }, 406);
    }
    const username = normalizeHandle(c.req.param("username"));
    const account = await deps.storage.getAccountByUsername(username);
    if (!account) return c.notFound();
    const followers = await deps.storage.listFollowersByUsername(username);
    const remoteFollowerActorUris = await deps.storage.listRemoteFollowerActorUrisByUsername(username);
    const orderedItems = Array.from(new Set([
      ...followers.map((follower) => `${deps.baseUrl}/users/${follower.username}`),
      ...remoteFollowerActorUris,
    ]));
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${deps.baseUrl}/users/${username}/followers`,
      type: "OrderedCollection",
      totalItems: orderedItems.length,
      orderedItems,
    }, 200, { "Content-Type": AP_CONTENT_TYPE });
  });

  app.get("/users/:username/following", async (c) => {
    if (!isActivityPubRequest(c.req.header("accept") || "")) {
      return c.json({ error: "accept_activity_json" }, 406);
    }
    const username = normalizeHandle(c.req.param("username"));
    const account = await deps.storage.getAccountByUsername(username);
    if (!account) return c.notFound();
    const following = await deps.storage.listFollowingByUsername(username);
    const remoteFollowing = await deps.storage.listFollowedRemoteActors(account.id);
    const orderedItems = Array.from(new Set([
      ...following.map((followed) => `${deps.baseUrl}/users/${followed.username}`),
      ...remoteFollowing.map((actor) => actor.uri),
    ]));
    return c.json({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${deps.baseUrl}/users/${username}/following`,
      type: "OrderedCollection",
      totalItems: orderedItems.length,
      orderedItems,
    }, 200, { "Content-Type": AP_CONTENT_TYPE });
  });

  app.post("/users/:username/inbox", async (c) => {
    const username = normalizeHandle(c.req.param("username"));
    const account = await deps.storage.getAccountByUsername(username);
    if (!account) return c.notFound();
    const body = await c.req.json<InboxActivity>();
    if (body.type === "Follow" && body.actor && body.inbox) {
      await deps.storage.addRemoteFollow(account.id, body.actor, body.inbox);
      return c.json({ ok: true, accepted: "follow" });
    }
    if (body.type === "Undo" && body.object && typeof body.object !== "string" && body.object.type === "Follow" && body.object.actor) {
      await deps.storage.removeRemoteFollow(account.id, body.object.actor);
      return c.json({ ok: true, accepted: "undo-follow" });
    }
    return c.json({ ok: true });
  });

  app.get("/events/:id", async (c) => {
    if (!isActivityPubRequest(c.req.header("accept") || "")) {
      return c.json({ error: "accept_activity_json" }, 406);
    }
    const event = await deps.storage.getEventById(c.req.param("id"));
    if (!event) return c.notFound();
    return c.json(toActivityPubEvent({
      id: `${deps.baseUrl}/events/${event.id}`,
      title: event.title,
      description: event.description || "",
      startDate: event.startDate,
      endDate: event.endDate || undefined,
      allDay: false,
      visibility: event.visibility,
      createdAt: event.startDate,
      updatedAt: event.startDate,
      url: `${deps.baseUrl}/events/${event.id}`,
    }), 200, { "Content-Type": AP_CONTENT_TYPE });
  });

  app.post("/inbox", async (c) => {
    const body = await c.req.json<InboxActivity>();

    if (deps.verifyInboxRequest) {
      const verification = await deps.verifyInboxRequest({ request: c.req.raw, activity: body });
      if (!verification.ok) {
        return c.json({ error: verification.error || "invalid_signature" }, verification.status || 401);
      }
    }

    const followTargetUsername = resolveFollowTargetUsername(body, deps.baseUrl);
    if (followTargetUsername && body.actor && body.inbox) {
      const account = await deps.storage.getAccountByUsername(followTargetUsername);
      if (account) {
        await deps.storage.addRemoteFollow(account.id, body.actor, body.inbox);
        return c.json({ ok: true, accepted: "shared-follow" });
      }
    }

    const undoTargetUsername = resolveUndoTargetUsername(body, deps.baseUrl);
    if (undoTargetUsername && body.actor) {
      const account = await deps.storage.getAccountByUsername(undoTargetUsername);
      if (account) {
        await deps.storage.removeRemoteFollow(account.id, body.actor);
        return c.json({ ok: true, accepted: "shared-undo-follow" });
      }
    }

    return c.json({ ok: true });
  });

  return app;
}
