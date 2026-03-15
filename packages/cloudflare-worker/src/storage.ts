import type { UnifiedStorage, UnifiedAccount, UnifiedEvent, UnifiedIdentity, UploadObject, SavedLocation, RemoteActorSummary, RemoteEventSummary } from "@everycal/runtime-core";

export interface CloudflareBindings {
  DB: D1Database;
  UPLOADS: R2Bucket;
  BASE_URL: string;
  CORS_ORIGIN?: string;
  SSR_CACHE_MAX_AGE_SECONDS?: string;
  SSR_CACHE_STALE_WHILE_REVALIDATE_SECONDS?: string;
  SSR_EDGE_CACHE_ENABLED?: string;
  SSR_EDGE_CACHE_BYPASS_HEADER?: string;
  SSR_CACHE_TAG_VERSION?: string;
  SESSION_COOKIE_NAME?: string;
  JOBS_QUEUE?: Queue;
  JOBS_DLQ?: Queue;
  ACTIVITYPUB_PRIVATE_KEY_PEM?: string;
  REMINDERS_WEBHOOK_URL?: string;
  SCRAPERS_WEBHOOK_URL?: string;
  JOBS_WEBHOOK_TOKEN?: string;
  REMINDERS_SERVICE?: Fetcher;
  SCRAPERS_SERVICE?: Fetcher;
  RATE_LIMITS_KV?: KVNamespace;
  RATE_LIMITS_DO?: DurableObjectNamespace;
}

export class CloudflareStorage implements UnifiedStorage {
  constructor(private readonly env: CloudflareBindings) {}

  async getSession(token: string): Promise<{ token: string; accountId: string; expiresAt: string } | null> {
    const row = await this.env.DB.prepare(
      "SELECT token, account_id, expires_at FROM sessions WHERE token = ?1 AND expires_at > datetime('now')"
    ).bind(token).first<{ token: string; account_id: string; expires_at: string }>();
    return row ? { token: row.token, accountId: row.account_id, expiresAt: row.expires_at } : null;
  }

  async createSession(accountId: string): Promise<{ token: string; accountId: string; expiresAt: string }> {
    const token = crypto.randomUUID();
    await this.env.DB.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?1, ?2, datetime('now', '+14 day'))")
      .bind(token, accountId)
      .run();
    const row = await this.env.DB.prepare("SELECT token, account_id, expires_at FROM sessions WHERE token = ?1")
      .bind(token)
      .first<{ token: string; account_id: string; expires_at: string }>();
    if (!row) throw new Error("failed_to_create_session");
    return { token: row.token, accountId: row.account_id, expiresAt: row.expires_at };
  }

  async deleteSession(token: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run();
  }

  async getAccountById(id: string): Promise<UnifiedAccount | null> {
    const row = await this.env.DB.prepare(
      "SELECT id, username, display_name, avatar_url, password_hash FROM accounts WHERE id = ?1"
    ).bind(id).first<{ id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null }>();
    return row ? {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      passwordHash: row.password_hash,
    } : null;
  }

  async getAccountByUsername(username: string): Promise<UnifiedAccount | null> {
    const row = await this.env.DB.prepare(
      "SELECT id, username, display_name, avatar_url, password_hash FROM accounts WHERE username = ?1"
    ).bind(username).first<{ id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null }>();
    return row ? {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      passwordHash: row.password_hash,
    } : null;
  }

  async createAccount(input: { username: string; displayName: string; passwordHash: string }): Promise<UnifiedAccount> {
    const id = crypto.randomUUID();
    await this.env.DB.prepare("INSERT INTO accounts (id, username, display_name, password_hash) VALUES (?1, ?2, ?3, ?4)")
      .bind(id, input.username, input.displayName, input.passwordHash)
      .run();
    const account = await this.getAccountById(id);
    if (!account) throw new Error("failed_to_create_account");
    return account;
  }

  async listEventsForAccount(accountId: string): Promise<UnifiedEvent[]> {
    const result = await this.env.DB.prepare(
      "SELECT id, account_id, title, description, start_date, end_date, visibility FROM events WHERE account_id = ?1 ORDER BY start_date ASC"
    ).bind(accountId).all<{ id: string; account_id: string; title: string; description: string | null; start_date: string; end_date: string | null; visibility: UnifiedEvent['visibility'] }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
      visibility: row.visibility,
    }));
  }

  async createEvent(input: { accountId: string; title: string; description?: string; startDate: string; endDate?: string; visibility?: UnifiedEvent['visibility'] }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      "INSERT INTO events (id, account_id, title, description, start_date, end_date, visibility) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    ).bind(id, input.accountId, input.title, input.description ?? null, input.startDate, input.endDate ?? null, input.visibility ?? "public").run();
    return { id };
  }

  async getEventById(id: string): Promise<UnifiedEvent | null> {
    const row = await this.env.DB.prepare(
      "SELECT id, account_id, title, description, start_date, end_date, visibility FROM events WHERE id = ?1"
    ).bind(id).first<{ id: string; account_id: string; title: string; description: string | null; start_date: string; end_date: string | null; visibility: UnifiedEvent['visibility'] }>();
    return row ? {
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
      visibility: row.visibility,
    } : null;
  }

  async listPublicEventsByUsername(username: string, limit: number): Promise<UnifiedEvent[]> {
    const result = await this.env.DB.prepare(
      `SELECT e.id, e.account_id, e.title, e.description, e.start_date, e.end_date, e.visibility
       FROM events e JOIN accounts a ON a.id = e.account_id
       WHERE a.username = ?1 AND e.visibility IN ('public','unlisted')
       ORDER BY e.start_date ASC
       LIMIT ?2`
    ).bind(username, limit).all<{ id: string; account_id: string; title: string; description: string | null; start_date: string; end_date: string | null; visibility: UnifiedEvent['visibility'] }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
      visibility: row.visibility,
    }));
  }

  async createIdentity(ownerAccountId: string, input: { username: string; displayName: string }): Promise<UnifiedIdentity> {
    const id = crypto.randomUUID();
    await this.env.DB.prepare("INSERT INTO accounts (id, username, display_name, account_type) VALUES (?1, ?2, ?3, 'identity')")
      .bind(id, input.username, input.displayName)
      .run();
    await this.env.DB.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?1, ?2, 'owner')"
    ).bind(id, ownerAccountId).run();
    return { id, username: input.username, displayName: input.displayName, role: "owner" };
  }

  async listIdentitiesForMember(memberAccountId: string): Promise<UnifiedIdentity[]> {
    const result = await this.env.DB.prepare(
      `SELECT a.id, a.username, a.display_name, im.role
       FROM identity_memberships im JOIN accounts a ON a.id = im.identity_account_id
       WHERE im.member_account_id = ?1`
    ).bind(memberAccountId).all<{ id: string; username: string; display_name: string | null; role: "owner" | "editor" }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
    }));
  }

  async addRemoteFollow(accountId: string, actorUri: string, inbox: string): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO remote_follows (account_id, follower_actor_uri, follower_inbox) VALUES (?1, ?2, ?3) ON CONFLICT(account_id, follower_actor_uri) DO UPDATE SET follower_inbox = excluded.follower_inbox"
    ).bind(accountId, actorUri, inbox).run();
  }

  async removeRemoteFollow(accountId: string, actorUri: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM remote_follows WHERE account_id = ?1 AND follower_actor_uri = ?2").bind(accountId, actorUri).run();
  }


  async listFollowersByUsername(username: string): Promise<UnifiedAccount[]> {
    const result = await this.env.DB.prepare(
      `SELECT a.id, a.username, a.display_name, a.avatar_url, a.password_hash
       FROM follows f
       JOIN accounts target ON target.id = f.following_id
       JOIN accounts a ON a.id = f.follower_id
       WHERE target.username = ?1`
    ).bind(username).all<{ id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      passwordHash: row.password_hash,
    }));
  }

  async listRemoteFollowerActorUrisByUsername(username: string): Promise<string[]> {
    const result = await this.env.DB.prepare(
      `SELECT rf.follower_actor_uri
       FROM remote_follows rf
       JOIN accounts target ON target.id = rf.account_id
       WHERE target.username = ?1`
    ).bind(username).all<{ follower_actor_uri: string }>();
    return (result.results ?? []).map((row) => row.follower_actor_uri);
  }

  async listFollowingByUsername(username: string): Promise<UnifiedAccount[]> {
    const result = await this.env.DB.prepare(
      `SELECT a.id, a.username, a.display_name, a.avatar_url, a.password_hash
       FROM follows f
       JOIN accounts source ON source.id = f.follower_id
       JOIN accounts a ON a.id = f.following_id
       WHERE source.username = ?1`
    ).bind(username).all<{ id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      passwordHash: row.password_hash,
    }));
  }

  async listSavedLocations(accountId: string): Promise<SavedLocation[]> {
    const result = await this.env.DB.prepare(
      `SELECT id, name, address, latitude, longitude, used_at
       FROM saved_locations
       WHERE account_id = ?1
       ORDER BY used_at DESC`
    ).bind(accountId).all<{ id: number; name: string; address: string | null; latitude: number | null; longitude: number | null; used_at: string }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      latitude: row.latitude,
      longitude: row.longitude,
      usedAt: row.used_at,
    }));
  }

  async saveLocation(accountId: string, loc: { name: string; address?: string; latitude?: number; longitude?: number }): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO saved_locations (account_id, name, address, latitude, longitude, used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
       ON CONFLICT(account_id, name, address)
       DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude, used_at = datetime('now')`
    ).bind(accountId, loc.name.trim(), loc.address ?? null, loc.latitude ?? null, loc.longitude ?? null).run();
  }

  async deleteLocation(accountId: string, id: number): Promise<void> {
    await this.env.DB.prepare("DELETE FROM saved_locations WHERE id = ?1 AND account_id = ?2").bind(id, accountId).run();
  }


  async listRemoteActors(params?: { domain?: string; limit?: number }): Promise<RemoteActorSummary[]> {
    const limit = params?.limit ?? 20;
    const domain = params?.domain;
    const query = domain
      ? `SELECT uri, preferred_username, display_name, domain, inbox, icon_url FROM remote_actors WHERE domain = ?1 ORDER BY last_fetched_at DESC LIMIT ?2`
      : `SELECT uri, preferred_username, display_name, domain, inbox, icon_url FROM remote_actors ORDER BY last_fetched_at DESC LIMIT ?1`;
    const result = domain
      ? await this.env.DB.prepare(query).bind(domain, limit).all<{ uri: string; preferred_username: string; display_name: string | null; domain: string; inbox: string | null; icon_url: string | null }>()
      : await this.env.DB.prepare(query).bind(limit).all<{ uri: string; preferred_username: string; display_name: string | null; domain: string; inbox: string | null; icon_url: string | null }>();
    return (result.results ?? []).map((row) => ({
      uri: row.uri,
      username: row.preferred_username,
      displayName: row.display_name,
      domain: row.domain,
      inbox: row.inbox,
      iconUrl: row.icon_url,
    }));
  }


  async searchRemoteActors(query: string): Promise<RemoteActorSummary[]> {
    const q = `%${query.toLowerCase()}%`;
    const result = await this.env.DB.prepare(
      `SELECT uri, preferred_username, display_name, domain, inbox, icon_url
       FROM remote_actors
       WHERE lower(preferred_username) LIKE ?1 OR lower(display_name) LIKE ?1 OR lower(uri) LIKE ?1
       ORDER BY last_fetched_at DESC
       LIMIT 20`
    ).bind(q).all<{ uri: string; preferred_username: string; display_name: string | null; domain: string; inbox: string | null; icon_url: string | null }>();
    return (result.results ?? []).map((row) => ({
      uri: row.uri,
      username: row.preferred_username,
      displayName: row.display_name,
      domain: row.domain,
      inbox: row.inbox,
      iconUrl: row.icon_url,
    }));
  }

  async listFollowedRemoteActors(accountId: string): Promise<RemoteActorSummary[]> {
    const result = await this.env.DB.prepare(
      `SELECT ra.uri, ra.preferred_username, ra.display_name, ra.domain, rf.actor_inbox AS inbox, ra.icon_url
       FROM remote_following rf
       LEFT JOIN remote_actors ra ON ra.uri = rf.actor_uri
       WHERE rf.account_id = ?1
       ORDER BY rf.created_at DESC`
    ).bind(accountId).all<{ uri: string | null; preferred_username: string | null; display_name: string | null; domain: string | null; inbox: string; icon_url: string | null }>();
    return (result.results ?? []).map((row) => ({
      uri: row.uri || "",
      username: row.preferred_username || "",
      displayName: row.display_name,
      domain: row.domain || "",
      inbox: row.inbox,
      iconUrl: row.icon_url,
    })).filter((actor) => actor.uri.length > 0);
  }


  async upsertRemoteActor(actor: RemoteActorSummary & { inbox: string }): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO remote_actors (uri, preferred_username, display_name, domain, inbox, icon_url, last_fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
       ON CONFLICT(uri) DO UPDATE SET
         preferred_username = excluded.preferred_username,
         display_name = excluded.display_name,
         domain = excluded.domain,
         inbox = excluded.inbox,
         icon_url = excluded.icon_url,
         last_fetched_at = datetime('now')`
    ).bind(actor.uri, actor.username, actor.displayName ?? null, actor.domain, actor.inbox, actor.iconUrl ?? null).run();
  }

  async upsertRemoteEvent(event: RemoteEventSummary): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO remote_events (uri, actor_uri, title, description, start_date, end_date, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
       ON CONFLICT(uri) DO UPDATE SET
         actor_uri = excluded.actor_uri,
         title = excluded.title,
         description = excluded.description,
         start_date = excluded.start_date,
         end_date = excluded.end_date,
         fetched_at = datetime('now')`
    ).bind(event.uri, event.actorUri, event.title, event.description ?? null, event.startDate, event.endDate ?? null).run();
  }

  async followRemoteActor(accountId: string, actor: RemoteActorSummary & { inbox: string }): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO remote_following (account_id, actor_uri, actor_inbox)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(account_id, actor_uri) DO UPDATE SET actor_inbox = excluded.actor_inbox`
    ).bind(accountId, actor.uri, actor.inbox).run();
  }

  async unfollowRemoteActor(accountId: string, actorUri: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM remote_following WHERE account_id = ?1 AND actor_uri = ?2").bind(accountId, actorUri).run();
  }

  async listRemoteEvents(params?: { actor?: string; from?: string; limit?: number; offset?: number }): Promise<RemoteEventSummary[]> {
    const actor = params?.actor;
    const from = params?.from;
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    const where: string[] = [];
    const values: unknown[] = [];
    if (actor) {
      where.push(`actor_uri = ?${values.length + 1}`);
      values.push(actor);
    }
    if (from) {
      where.push(`start_date >= ?${values.length + 1}`);
      values.push(from);
    }
    values.push(limit, offset);
    const limIdx = values.length - 1;
    const offIdx = values.length;
    const query = `SELECT uri, actor_uri, title, description, start_date, end_date
      FROM remote_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY start_date ASC
      LIMIT ?${limIdx} OFFSET ?${offIdx}`;

    const result = await this.env.DB.prepare(query).bind(...values).all<{
      uri: string;
      actor_uri: string;
      title: string;
      description: string | null;
      start_date: string;
      end_date: string | null;
    }>();

    return (result.results ?? []).map((row) => ({
      uri: row.uri,
      actorUri: row.actor_uri,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
    }));
  }

  async putUpload(blob: { key: string; contentType: string; body: ArrayBuffer }): Promise<string> {
    await this.env.UPLOADS.put(blob.key, blob.body, { httpMetadata: { contentType: blob.contentType } });
    await this.env.DB.prepare(
      "INSERT INTO uploads (id, object_key, content_type) VALUES (?1, ?2, ?3) ON CONFLICT(object_key) DO UPDATE SET content_type = excluded.content_type"
    ).bind(blob.key, blob.key, blob.contentType).run();
    return `${this.env.BASE_URL}/uploads/${blob.key}`;
  }

  async getUpload(key: string): Promise<UploadObject | null> {
    const object = await this.env.UPLOADS.get(key);
    if (!object) return null;
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    return { body: object.body || "", contentType: headers.get("content-type") || undefined };
  }
}
