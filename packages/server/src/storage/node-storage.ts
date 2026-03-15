import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AccountRecord, EveryCalStorage, EventRecord, SessionRecord, UploadBlob } from "@everycal/core";
import type { UnifiedAccount, UnifiedEvent, UnifiedIdentity, UnifiedStorage, UploadObject, SavedLocation, RemoteActorSummary, RemoteEventSummary } from "@everycal/runtime-core";
import type { DB } from "../db.js";

export class NodeStorage implements EveryCalStorage, UnifiedStorage {
  runtime = "node" as const;

  constructor(
    private readonly db: DB,
    private readonly uploadDir: string
  ) {}

  async getSession(token: string): Promise<SessionRecord | null> {
    const row = this.db
      .prepare("SELECT token, account_id, expires_at FROM sessions WHERE token = ? AND expires_at > datetime('now')")
      .get(token) as { token: string; account_id: string; expires_at: string } | undefined;
    return row ? { token: row.token, accountId: row.account_id, expiresAt: row.expires_at } : null;
  }

  async createSession(accountId: string): Promise<SessionRecord> {
    const token = crypto.randomUUID();
    this.db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, datetime('now', '+14 day'))").run(token, accountId);
    const row = this.db.prepare("SELECT token, account_id, expires_at FROM sessions WHERE token = ?").get(token) as {
      token: string;
      account_id: string;
      expires_at: string;
    } | undefined;
    if (!row) throw new Error("failed_to_create_session");
    return { token: row.token, accountId: row.account_id, expiresAt: row.expires_at };
  }

  async deleteSession(token: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  async getAccountById(id: string): Promise<AccountRecord | null> {
    const row = this.db
      .prepare("SELECT id, username, display_name, avatar_url, password_hash FROM accounts WHERE id = ?")
      .get(id) as { id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null } | undefined;
    return row ? {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      passwordHash: row.password_hash,
    } as UnifiedAccount : null;
  }

  async getAccountByUsername(username: string): Promise<UnifiedAccount | null> {
    const row = this.db
      .prepare("SELECT id, username, display_name, avatar_url, password_hash FROM accounts WHERE username = ?")
      .get(username) as { id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null } | undefined;
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
    this.db.prepare("INSERT INTO accounts (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)")
      .run(id, input.username, input.displayName, input.passwordHash);
    const account = await this.getAccountById(id);
    if (!account) throw new Error("failed_to_create_account");
    return account as UnifiedAccount;
  }

  async listPublicEventsByUsername(username: string, limit = 50): Promise<EventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.account_id, e.title, e.description, e.start_date, e.end_date, e.visibility
         FROM events e JOIN accounts a ON a.id = e.account_id
         WHERE a.username = ? AND e.visibility IN ('public','unlisted')
         ORDER BY e.start_date ASC LIMIT ?`
      )
      .all(username, limit) as Array<{
        id: string;
        account_id: string;
        title: string;
        description: string | null;
        start_date: string;
        end_date: string | null;
        visibility: UnifiedEvent["visibility"];
      }>;

    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
      visibility: row.visibility,
    }));
  }

  async listEventsForAccount(accountId: string): Promise<UnifiedEvent[]> {
    const rows = this.db
      .prepare("SELECT id, account_id, title, description, start_date, end_date, visibility FROM events WHERE account_id = ? ORDER BY start_date ASC")
      .all(accountId) as Array<{ id: string; account_id: string; title: string; description: string | null; start_date: string; end_date: string | null; visibility: UnifiedEvent['visibility'] }>;

    return rows.map((row) => ({
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
    this.db.prepare(
      "INSERT INTO events (id, account_id, title, description, start_date, end_date, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, input.accountId, input.title, input.description ?? null, input.startDate, input.endDate ?? null, input.visibility ?? "public");
    return { id };
  }

  async getEventById(id: string): Promise<UnifiedEvent | null> {
    const row = this.db.prepare(
      "SELECT id, account_id, title, description, start_date, end_date, visibility FROM events WHERE id = ?"
    ).get(id) as { id: string; account_id: string; title: string; description: string | null; start_date: string; end_date: string | null; visibility: UnifiedEvent['visibility'] } | undefined;
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

  async createIdentity(ownerAccountId: string, input: { username: string; displayName: string }): Promise<UnifiedIdentity> {
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO accounts (id, username, display_name, account_type) VALUES (?, ?, ?, 'identity')")
      .run(id, input.username, input.displayName);
    this.db.prepare("INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'owner')")
      .run(id, ownerAccountId);
    return { id, username: input.username, displayName: input.displayName, role: "owner" };
  }

  async listIdentitiesForMember(memberAccountId: string): Promise<UnifiedIdentity[]> {
    const rows = this.db.prepare(
      `SELECT a.id, a.username, a.display_name, im.role
       FROM identity_memberships im JOIN accounts a ON a.id = im.identity_account_id
       WHERE im.member_account_id = ?`
    ).all(memberAccountId) as Array<{ id: string; username: string; display_name: string | null; role: "owner" | "editor" }>;
    return rows.map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role }));
  }

  async addRemoteFollow(accountId: string, actorUri: string, inbox: string): Promise<void> {
    this.db.prepare(
      "INSERT INTO remote_follows (account_id, follower_actor_uri, follower_inbox) VALUES (?, ?, ?) ON CONFLICT(account_id, follower_actor_uri) DO UPDATE SET follower_inbox = excluded.follower_inbox"
    ).run(accountId, actorUri, inbox);
  }

  async removeRemoteFollow(accountId: string, actorUri: string): Promise<void> {
    this.db.prepare("DELETE FROM remote_follows WHERE account_id = ? AND follower_actor_uri = ?").run(accountId, actorUri);
  }


  async listFollowersByUsername(username: string): Promise<UnifiedAccount[]> {
    const rows = this.db.prepare(
      `SELECT a.id, a.username, a.display_name, a.avatar_url, a.password_hash
       FROM follows f
       JOIN accounts target ON target.id = f.following_id
       JOIN accounts a ON a.id = f.follower_id
       WHERE target.username = ?`
    ).all(username) as Array<{ id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null }>;
    return rows.map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url, passwordHash: row.password_hash }));
  }

  async listRemoteFollowerActorUrisByUsername(username: string): Promise<string[]> {
    const rows = this.db.prepare(
      `SELECT rf.follower_actor_uri
       FROM remote_follows rf
       JOIN accounts target ON target.id = rf.account_id
       WHERE target.username = ?`
    ).all(username) as Array<{ follower_actor_uri: string }>;
    return rows.map((row) => row.follower_actor_uri);
  }

  async listFollowingByUsername(username: string): Promise<UnifiedAccount[]> {
    const rows = this.db.prepare(
      `SELECT a.id, a.username, a.display_name, a.avatar_url, a.password_hash
       FROM follows f
       JOIN accounts source ON source.id = f.follower_id
       JOIN accounts a ON a.id = f.following_id
       WHERE source.username = ?`
    ).all(username) as Array<{ id: string; username: string; display_name: string | null; avatar_url: string | null; password_hash: string | null }>;
    return rows.map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url, passwordHash: row.password_hash }));
  }

  async listSavedLocations(accountId: string): Promise<SavedLocation[]> {
    const rows = this.db.prepare(
      `SELECT id, name, address, latitude, longitude, used_at
       FROM saved_locations
       WHERE account_id = ?
       ORDER BY used_at DESC`
    ).all(accountId) as Array<{ id: number; name: string; address: string | null; latitude: number | null; longitude: number | null; used_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      latitude: row.latitude,
      longitude: row.longitude,
      usedAt: row.used_at,
    }));
  }

  async saveLocation(accountId: string, loc: { name: string; address?: string; latitude?: number; longitude?: number }): Promise<void> {
    this.db.prepare(
      `INSERT INTO saved_locations (account_id, name, address, latitude, longitude, used_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, name, address)
       DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude, used_at = datetime('now')`
    ).run(accountId, loc.name.trim(), loc.address ?? null, loc.latitude ?? null, loc.longitude ?? null);
  }

  async deleteLocation(accountId: string, id: number): Promise<void> {
    this.db.prepare("DELETE FROM saved_locations WHERE id = ? AND account_id = ?").run(id, accountId);
  }

  async upsertUpload(blob: UploadBlob): Promise<string> {
    return this.putUpload(blob);
  }


  async listRemoteActors(params?: { domain?: string; limit?: number }): Promise<RemoteActorSummary[]> {
    const limit = params?.limit ?? 20;
    const rows = params?.domain
      ? this.db.prepare("SELECT uri, preferred_username, display_name, domain, inbox, icon_url FROM remote_actors WHERE domain = ? ORDER BY last_fetched_at DESC LIMIT ?").all(params.domain, limit)
      : this.db.prepare("SELECT uri, preferred_username, display_name, domain, inbox, icon_url FROM remote_actors ORDER BY last_fetched_at DESC LIMIT ?").all(limit);
    return (rows as Array<{ uri: string; preferred_username: string; display_name: string | null; domain: string; inbox: string | null }>).map((row) => ({
      uri: row.uri,
      username: row.preferred_username,
      displayName: row.display_name,
      domain: row.domain,
      inbox: row.inbox,
      iconUrl: row.icon_url,
    }));
  }


  async searchRemoteActors(query: string): Promise<RemoteActorSummary[]> {
    const rows = this.db.prepare(
      `SELECT uri, preferred_username, display_name, domain, inbox, icon_url
       FROM remote_actors
       WHERE lower(preferred_username) LIKE lower(?) OR lower(display_name) LIKE lower(?) OR lower(uri) LIKE lower(?)
       ORDER BY last_fetched_at DESC
       LIMIT 20`
    ).all(`%${query}%`, `%${query}%`, `%${query}%`) as Array<{ uri: string; preferred_username: string; display_name: string | null; domain: string; inbox: string | null; icon_url: string | null }>;
    return rows.map((row) => ({
      uri: row.uri,
      username: row.preferred_username,
      displayName: row.display_name,
      domain: row.domain,
      inbox: row.inbox,
      iconUrl: row.icon_url,
    }));
  }

  async listFollowedRemoteActors(accountId: string): Promise<RemoteActorSummary[]> {
    const rows = this.db.prepare(
      `SELECT ra.uri, ra.preferred_username, ra.display_name, ra.domain, rf.actor_inbox AS inbox, ra.icon_url
       FROM remote_following rf
       LEFT JOIN remote_actors ra ON ra.uri = rf.actor_uri
       WHERE rf.account_id = ?
       ORDER BY rf.created_at DESC`
    ).all(accountId) as Array<{ uri: string | null; preferred_username: string | null; display_name: string | null; domain: string | null; inbox: string; icon_url: string | null }>;
    return rows.filter((row) => !!row.uri).map((row) => ({
      uri: row.uri as string,
      username: row.preferred_username || "",
      displayName: row.display_name,
      domain: row.domain || "",
      inbox: row.inbox,
      iconUrl: row.icon_url,
    }));
  }


  async upsertRemoteActor(actor: RemoteActorSummary & { inbox: string }): Promise<void> {
    this.db.prepare(
      `INSERT INTO remote_actors (uri, preferred_username, display_name, domain, inbox, icon_url, last_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(uri) DO UPDATE SET
         preferred_username = excluded.preferred_username,
         display_name = excluded.display_name,
         domain = excluded.domain,
         inbox = excluded.inbox,
         icon_url = excluded.icon_url,
         last_fetched_at = datetime('now')`
    ).run(actor.uri, actor.username, actor.displayName ?? null, actor.domain, actor.inbox, actor.iconUrl ?? null);
  }

  async upsertRemoteEvent(event: RemoteEventSummary): Promise<void> {
    this.db.prepare(
      `INSERT INTO remote_events (uri, actor_uri, title, description, start_date, end_date, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(uri) DO UPDATE SET
         actor_uri = excluded.actor_uri,
         title = excluded.title,
         description = excluded.description,
         start_date = excluded.start_date,
         end_date = excluded.end_date,
         fetched_at = datetime('now')`
    ).run(event.uri, event.actorUri, event.title, event.description ?? null, event.startDate, event.endDate ?? null);
  }

  async followRemoteActor(accountId: string, actor: RemoteActorSummary & { inbox: string }): Promise<void> {
    this.db.prepare(
      `INSERT INTO remote_following (account_id, actor_uri, actor_inbox)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, actor_uri) DO UPDATE SET actor_inbox = excluded.actor_inbox`
    ).run(accountId, actor.uri, actor.inbox);
  }

  async unfollowRemoteActor(accountId: string, actorUri: string): Promise<void> {
    this.db.prepare("DELETE FROM remote_following WHERE account_id = ? AND actor_uri = ?").run(accountId, actorUri);
  }

  async listRemoteEvents(params?: { actor?: string; from?: string; limit?: number; offset?: number }): Promise<RemoteEventSummary[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params?.actor) {
      where.push("actor_uri = ?");
      args.push(params.actor);
    }
    if (params?.from) {
      where.push("start_date >= ?");
      args.push(params.from);
    }
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;
    const sql = `SELECT uri, actor_uri, title, description, start_date, end_date
      FROM remote_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY start_date ASC
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...args, limit, offset) as Array<{ uri: string; actor_uri: string; title: string; description: string | null; start_date: string; end_date: string | null }>;
    return rows.map((row) => ({
      uri: row.uri,
      actorUri: row.actor_uri,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
    }));
  }

  async putUpload(blob: { key: string; contentType: string; body: ArrayBuffer }): Promise<string> {
    const filePath = join(this.uploadDir, blob.key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(blob.body));
    return `/uploads/${blob.key}`;
  }

  async getUpload(key: string): Promise<UploadObject | null> {
    try {
      const filePath = join(this.uploadDir, key);
      const data = await readFile(filePath);
      return { body: data };
    } catch {
      return null;
    }
  }
}
