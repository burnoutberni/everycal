import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase, type DB } from "../src/db.js";

vi.mock("../src/lib/security.js", () => ({
  isPrivateIP: () => false,
  sanitizeHtml: (value: string) => value,
  assertPublicResolvedIP: vi.fn(async () => undefined),
}));

import { resolveRemoteActor } from "../src/lib/federation.js";

describe("resolveRemoteActor fetch status tracking", () => {
  let db: DB;
  const fetchMock = vi.fn();
  const actorUri = "https://remote.example/users/alice";

  beforeEach(() => {
    db = initDatabase(":memory:");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();

    db.prepare(
      `INSERT INTO remote_actors (uri, type, preferred_username, display_name, inbox, domain, last_fetched_at)
       VALUES (?, 'Person', 'alice', 'Alice', 'https://remote.example/inbox', 'remote.example', ?)`
    ).run(actorUri, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
  });

  it("marks cached actor as gone when upstream returns 410", async () => {
    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("acc-1", "owner");
    db.prepare(
      `INSERT INTO remote_following (account_id, actor_uri, actor_inbox)
       VALUES (?, ?, ?)`
    ).run("acc-1", actorUri, "https://remote.example/inbox");
    db.prepare(
      `INSERT INTO remote_follows (account_id, follower_actor_uri, follower_inbox)
       VALUES (?, ?, ?)`
    ).run("acc-1", actorUri, "https://remote.example/inbox");

    fetchMock.mockResolvedValueOnce({ ok: false, status: 410, statusText: "Gone" } as Response);

    const actor = await resolveRemoteActor(db, actorUri, true);
    expect(actor).toBeNull();

    const row = db
      .prepare("SELECT fetch_status, last_error, next_retry_at, gone_at FROM remote_actors WHERE uri = ?")
      .get(actorUri) as {
        fetch_status: string;
        last_error: string | null;
        next_retry_at: string | null;
        gone_at: string | null;
      };

    expect(row.fetch_status).toBe("gone");
    expect(row.last_error).toContain("410 Gone");
    expect(row.next_retry_at).toBeNull();
    expect(row.gone_at).toBeTruthy();

    const followingCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM remote_following WHERE actor_uri = ?")
      .get(actorUri) as { cnt: number };
    const followersCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM remote_follows WHERE follower_actor_uri = ?")
      .get(actorUri) as { cnt: number };
    expect(followingCount.cnt).toBe(0);
    expect(followersCount.cnt).toBe(0);
  });

  it("stores retry metadata for 404 instead of marking actor gone", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" } as Response);

    const actor = await resolveRemoteActor(db, actorUri, true);
    expect(actor).toBeNull();

    const row = db
      .prepare("SELECT fetch_status, next_retry_at, gone_at FROM remote_actors WHERE uri = ?")
      .get(actorUri) as {
        fetch_status: string;
        next_retry_at: string | null;
        gone_at: string | null;
      };

    expect(row.fetch_status).toBe("error");
    expect(row.next_retry_at).toBeTruthy();
    expect(row.gone_at).toBeNull();
  });

  it("stores retry metadata on transient upstream failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error" } as Response);

    const actor = await resolveRemoteActor(db, actorUri, true);
    expect(actor).toBeNull();

    const row = db
      .prepare("SELECT fetch_status, next_retry_at, gone_at FROM remote_actors WHERE uri = ?")
      .get(actorUri) as {
        fetch_status: string;
        next_retry_at: string | null;
        gone_at: string | null;
      };

    expect(row.fetch_status).toBe("error");
    expect(row.next_retry_at).toBeTruthy();
    expect(row.gone_at).toBeNull();
  });

  it("persists gone state for uncached actors", async () => {
    const uncachedActorUri = "https://remote.example/users/missing";
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410, statusText: "Gone" } as Response);

    const actor = await resolveRemoteActor(db, uncachedActorUri, true);
    expect(actor).toBeNull();

    const row = db
      .prepare("SELECT fetch_status, preferred_username, display_name FROM remote_actors WHERE uri = ?")
      .get(uncachedActorUri) as {
        fetch_status: string;
        preferred_username: string;
        display_name: string | null;
      };

    expect(row.fetch_status).toBe("gone");
    expect(row.preferred_username).toBe("missing");
    expect(row.display_name).toBe("Deleted account");
  });
});
