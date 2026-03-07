import { describe, expect, it } from "vitest";
import { createUnifiedApp, type UnifiedEvent, type UnifiedIdentity, type UnifiedStorage, type UploadObject } from "./index";

class MemoryStorage implements UnifiedStorage {
  private accounts = new Map<string, { id: string; username: string; displayName: string | null; avatarUrl: string | null; passwordHash: string | null }>();
  private sessions = new Map<string, { token: string; accountId: string; expiresAt: string }>();
  public remoteFollows = new Map<string, Set<string>>();
  public localFollows = new Map<string, Set<string>>();
  public remoteFollowersByUsername = new Map<string, Set<string>>();
  public remoteFollowingByAccountId = new Map<string, Set<string>>();
  public remoteActors = new Map<string, { uri: string; username: string; displayName: string | null; domain: string; inbox: string | null; iconUrl: string | null }>();
  public remoteEvents = new Map<string, { uri: string; actorUri: string; title: string; description: string | null; startDate: string; endDate: string | null }>();

  getAccountIdByUsername(username: string): string | null {
    return Array.from(this.accounts.values()).find((a) => a.username === username)?.id ?? null;
  }

  async getSession(token: string) { return this.sessions.get(token) ?? null; }
  async createSession(accountId: string) {
    const s = { token: crypto.randomUUID(), accountId, expiresAt: new Date(Date.now() + 86400000).toISOString() };
    this.sessions.set(s.token, s);
    return s;
  }
  async deleteSession(token: string) { this.sessions.delete(token); }
  async getAccountById(id: string) { return this.accounts.get(id) ?? null; }
  async getAccountByUsername(username: string) { return Array.from(this.accounts.values()).find((a) => a.username === username) ?? null; }
  async createAccount(input: { username: string; displayName: string; passwordHash: string }) {
    const id = crypto.randomUUID();
    const a = { id, username: input.username, displayName: input.displayName, avatarUrl: null, passwordHash: input.passwordHash };
    this.accounts.set(id, a);
    return a;
  }
  async listEventsForAccount(_accountId: string): Promise<UnifiedEvent[]> { return []; }
  async createEvent(_input: { accountId: string; title: string; description?: string; startDate: string; endDate?: string; visibility?: UnifiedEvent["visibility"] }) { return { id: crypto.randomUUID() }; }
  async getEventById(_id: string): Promise<UnifiedEvent | null> { return null; }
  async listPublicEventsByUsername(_username: string, _limit: number): Promise<UnifiedEvent[]> { return []; }
  async createIdentity(_ownerAccountId: string, input: { username: string; displayName: string }): Promise<UnifiedIdentity> { return { id: crypto.randomUUID(), username: input.username, displayName: input.displayName, role: "owner" }; }
  async listIdentitiesForMember(_memberAccountId: string): Promise<UnifiedIdentity[]> { return []; }
  async addRemoteFollow(accountId: string, actorUri: string, _inbox: string): Promise<void> {
    if (!this.remoteFollows.has(accountId)) this.remoteFollows.set(accountId, new Set());
    this.remoteFollows.get(accountId)?.add(actorUri);
  }
  async removeRemoteFollow(accountId: string, actorUri: string): Promise<void> {
    this.remoteFollows.get(accountId)?.delete(actorUri);
  }
  async listFollowersByUsername(username: string) {
    const targetId = this.getAccountIdByUsername(username);
    if (!targetId) return [];
    const followerIds = Array.from(this.localFollows.entries())
      .filter(([, following]) => following.has(targetId))
      .map(([followerId]) => followerId);
    return followerIds
      .map((id) => this.accounts.get(id))
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
  }
  async listRemoteFollowerActorUrisByUsername(username: string): Promise<string[]> {
    return Array.from(this.remoteFollowersByUsername.get(username) ?? []);
  }
  async listFollowingByUsername(username: string) {
    const accountId = this.getAccountIdByUsername(username);
    if (!accountId) return [];
    const followingIds = Array.from(this.localFollows.get(accountId) ?? []);
    return followingIds
      .map((id) => this.accounts.get(id))
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
  }
  async listSavedLocations(_accountId: string) { return []; }
  async saveLocation(_accountId: string, _loc: { name: string; address?: string; latitude?: number; longitude?: number }) { return; }
  async deleteLocation(_accountId: string, _id: number) { return; }
  async listRemoteActors() { return Array.from(this.remoteActors.values()); }
  async searchRemoteActors(query = "") {
    const q = query.toLowerCase();
    return Array.from(this.remoteActors.values()).filter((actor) => actor.uri.toLowerCase().includes(q) || actor.username.toLowerCase().includes(q));
  }
  async listFollowedRemoteActors(accountId: string) {
    return Array.from(this.remoteFollowingByAccountId.get(accountId) ?? []).map((uri) => {
      const existing = this.remoteActors.get(uri);
      return existing ?? {
        uri,
        username: uri.split("/").pop() ?? "",
        displayName: null,
        domain: "remote.example",
        inbox: null,
        iconUrl: null,
      };
    });
  }
  async upsertRemoteActor(actor: { uri: string; username: string; displayName: string | null; domain: string; inbox: string; iconUrl?: string | null }) { this.remoteActors.set(actor.uri, { ...actor, inbox: actor.inbox, iconUrl: actor.iconUrl ?? null }); return; }
  async upsertRemoteEvent(event: { uri: string; actorUri: string; title: string; description: string | null; startDate: string; endDate: string | null }) { this.remoteEvents.set(event.uri, event); return; }
  async followRemoteActor(accountId: string, actor: { uri: string; username: string; displayName: string | null; domain: string; inbox: string; iconUrl?: string | null }) {
    if (!this.remoteFollowingByAccountId.has(accountId)) this.remoteFollowingByAccountId.set(accountId, new Set());
    this.remoteFollowingByAccountId.get(accountId)?.add(actor.uri);
    this.remoteActors.set(actor.uri, { ...actor, inbox: actor.inbox, iconUrl: actor.iconUrl ?? null });
    return;
  }
  async unfollowRemoteActor(accountId: string, actorUri: string) {
    this.remoteFollowingByAccountId.get(accountId)?.delete(actorUri);
    return;
  }
  async listRemoteEvents() { return []; }
  async putUpload(blob: { key: string; contentType: string; body: ArrayBuffer }): Promise<string> { return `/uploads/${blob.key}`; }
  async getUpload(_key: string): Promise<UploadObject | null> { return null; }
}

describe("createUnifiedApp", () => {
  it("registers and returns bootstrap with auth", async () => {
    const app = createUnifiedApp({
      storage: new MemoryStorage(),
      baseUrl: "https://example.com",
      sessionCookieName: "everycal_session",
      hashPassword: async (p) => `hash:${p}`,
      verifyPassword: async (p, h) => h === `hash:${p}`,
    });

    const registerRes = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password123" }),
    });
    expect(registerRes.status).toBe(201);
    const cookie = registerRes.headers.get("set-cookie");
    expect(cookie).toContain("everycal_session=");

    const bootstrapRes = await app.request("http://localhost/api/v1/bootstrap", {
      headers: { cookie: cookie || "" },
    });
    const bootstrap = await bootstrapRes.json();
    expect(bootstrap.authenticated).toBe(true);
  });




  it("requires ActivityPub Accept header for actor/event endpoints", async () => {
    const storage = new MemoryStorage();
    await storage.createAccount({ username: "alice", displayName: "Alice", passwordHash: "hash:a" });
    const app = createUnifiedApp({
      storage,
      baseUrl: "https://example.com",
      sessionCookieName: "everycal_session",
      hashPassword: async (p) => `hash:${p}`,
      verifyPassword: async (p, h) => h === `hash:${p}`,
    });

    const actorRes = await app.request("http://localhost/users/alice", {
      headers: { accept: "text/html" },
    });
    expect(actorRes.status).toBe(406);

    const eventRes = await app.request("http://localhost/events/any", {
      headers: { accept: "application/json" },
    });
    expect(eventRes.status).toBe(406);
  });

  it("returns ActivityPub follower/following collections with totals", async () => {
    const storage = new MemoryStorage();
    await storage.createAccount({ username: "alice", displayName: "Alice", passwordHash: "hash:a" });
    await storage.createAccount({ username: "bob", displayName: "Bob", passwordHash: "hash:b" });
    await storage.createAccount({ username: "carol", displayName: "Carol", passwordHash: "hash:c" });

    const aliceId = storage.getAccountIdByUsername("alice") as string;
    const bobId = storage.getAccountIdByUsername("bob") as string;
    const carolId = storage.getAccountIdByUsername("carol") as string;

    storage.localFollows.set(bobId, new Set([aliceId]));
    storage.localFollows.set(aliceId, new Set([carolId]));
    storage.remoteFollowersByUsername.set("alice", new Set(["https://remote.example/users/zoe"]));
    storage.remoteFollowingByAccountId.set(aliceId, new Set(["https://remote.example/users/erin"]));

    const app = createUnifiedApp({
      storage,
      baseUrl: "https://example.com",
      sessionCookieName: "everycal_session",
      hashPassword: async (p) => `hash:${p}`,
      verifyPassword: async (p, h) => h === `hash:${p}`,
    });

    const followersRes = await app.request("http://localhost/users/alice/followers", {
      headers: { accept: "application/activity+json" },
    });
    expect(followersRes.status).toBe(200);
    expect(followersRes.headers.get("content-type") || "").toContain("application/activity+json");
    const followersBody = await followersRes.json() as { totalItems: number; orderedItems: string[] };
    expect(followersBody.totalItems).toBe(2);
    expect(followersBody.orderedItems).toContain("https://example.com/users/bob");
    expect(followersBody.orderedItems).toContain("https://remote.example/users/zoe");

    const followingRes = await app.request("http://localhost/users/alice/following", {
      headers: { accept: "application/activity+json" },
    });
    expect(followingRes.status).toBe(200);
    expect(followingRes.headers.get("content-type") || "").toContain("application/activity+json");
    const followingBody = await followingRes.json() as { totalItems: number; orderedItems: string[] };
    expect(followingBody.totalItems).toBe(2);
    expect(followingBody.orderedItems).toContain("https://example.com/users/carol");
    expect(followingBody.orderedItems).toContain("https://remote.example/users/erin");
  });



  it("validates shared inbox requests with verifyInboxRequest hook", async () => {
    const storage = new MemoryStorage();
    await storage.createAccount({ username: "alice", displayName: "Alice", passwordHash: "hash:a" });

    const app = createUnifiedApp({
      storage,
      baseUrl: "https://example.com",
      sessionCookieName: "everycal_session",
      hashPassword: async (p) => `hash:${p}`,
      verifyPassword: async (p, h) => h === `hash:${p}`,
      verifyInboxRequest: async () => ({ ok: false, status: 401, error: "invalid_signature" }),
    });

    const res = await app.request("http://localhost/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Follow",
        actor: "https://remote.example/users/bob",
        inbox: "https://remote.example/inbox",
        object: "https://example.com/users/alice",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_signature");
  });


  it("syncs actor and delivers follow/unfollow activities via hooks", async () => {
    const storage = new MemoryStorage();
    const account = await storage.createAccount({ username: "alice", displayName: "Alice", passwordHash: "hash:a" });
    const delivered: Array<{ inbox: string; activity: Record<string, unknown> }> = [];

    const app = createUnifiedApp({
      storage,
      baseUrl: "https://example.com",
      sessionCookieName: "everycal_session",
      hashPassword: async (p) => `hash:${p}`,
      verifyPassword: async (p, h) => h === `hash:${p}`,
      deliverActivity: async ({ inbox, activity }) => {
        delivered.push({ inbox, activity });
        return { ok: true, status: 202 };
      },
      syncRemoteActorAndEvents: async (actorUri) => {
        const actor = {
          uri: actorUri,
          username: "remote",
          displayName: "Remote",
          domain: "remote.example",
          inbox: "https://remote.example/inbox",
          iconUrl: null,
        };
        await storage.upsertRemoteActor(actor);
        await storage.upsertRemoteEvent({
          uri: `${actorUri}/events/1`,
          actorUri,
          title: "Imported Event",
          description: null,
          startDate: "2030-01-01T00:00:00.000Z",
          endDate: null,
        });
        return { actor, eventsSynced: 1 };
      },
    });

    const session = await storage.createSession(account.id);
    const cookie = `everycal_session=${session.token}`;

    const syncRes = await app.request("http://localhost/api/v1/federation/sync", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ actorUri: "https://remote.example/users/bob" }),
    });
    expect(syncRes.status).toBe(200);

    const followRes = await app.request("http://localhost/api/v1/federation/follow", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ actorUri: "https://remote.example/users/bob" }),
    });
    expect(followRes.status).toBe(200);

    storage.remoteFollowingByAccountId.set(account.id, new Set(["https://remote.example/users/bob"]));
    const unfollowRes = await app.request("http://localhost/api/v1/federation/unfollow", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ actorUri: "https://remote.example/users/bob" }),
    });
    expect(unfollowRes.status).toBe(200);

    expect(delivered.length).toBeGreaterThanOrEqual(1);
  });

  it("handles shared inbox Follow and Undo(Follow) for local target actor", async () => {
    const storage = new MemoryStorage();
    await storage.createAccount({ username: "alice", displayName: "Alice", passwordHash: "hash:a" });

    const app = createUnifiedApp({
      storage,
      baseUrl: "https://example.com",
      sessionCookieName: "everycal_session",
      hashPassword: async (p) => `hash:${p}`,
      verifyPassword: async (p, h) => h === `hash:${p}`,
    });

    const accountId = storage.getAccountIdByUsername("alice") as string;

    const followRes = await app.request("http://localhost/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Follow",
        actor: "https://remote.example/users/bob",
        inbox: "https://remote.example/inbox",
        object: "https://example.com/users/alice",
      }),
    });
    expect(followRes.status).toBe(200);
    expect(storage.remoteFollows.get(accountId)?.has("https://remote.example/users/bob")).toBe(true);

    const undoRes = await app.request("http://localhost/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Undo",
        actor: "https://remote.example/users/bob",
        object: {
          type: "Follow",
          actor: "https://remote.example/users/bob",
          object: "https://example.com/users/alice",
        },
      }),
    });
    expect(undoRes.status).toBe(200);
    expect(storage.remoteFollows.get(accountId)?.has("https://remote.example/users/bob")).toBe(false);
  });

  it("handles Follow and Undo(Follow) in user inbox", async () => {
    const storage = new MemoryStorage();
    const app = createUnifiedApp({
      storage,
      baseUrl: "https://example.com",
      sessionCookieName: "everycal_session",
      hashPassword: async (p) => `hash:${p}`,
      verifyPassword: async (p, h) => h === `hash:${p}`,
    });

    await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password123" }),
    });

    const accountId = storage.getAccountIdByUsername("alice");
    expect(accountId).toBeTruthy();

    const followRes = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "Follow", actor: "https://remote.example/users/bob", inbox: "https://remote.example/inbox" }),
    });
    expect(followRes.status).toBe(200);
    expect(storage.remoteFollows.get(accountId as string)?.has("https://remote.example/users/bob")).toBe(true);

    const undoRes = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "Undo", object: { type: "Follow", actor: "https://remote.example/users/bob" } }),
    });
    expect(undoRes.status).toBe(200);
    expect(storage.remoteFollows.get(accountId as string)?.has("https://remote.example/users/bob")).toBe(false);
  });
});
