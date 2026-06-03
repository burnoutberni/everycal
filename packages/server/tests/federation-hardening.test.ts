import { describe, expect, it, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { authMiddleware, createSession } from "../src/middleware/auth.js";
import { activityPubRoutes, sharedInboxRoute } from "../src/routes/activitypub.js";
import { federationRoutes } from "../src/routes/federation-api.js";
import { serializeRemoteEvent } from "../src/lib/event-serializers.js";
import { upsertRemoteEvent } from "../src/lib/remote-events.js";
import * as remoteEvents from "../src/lib/remote-events.js";
import * as federation from "../src/lib/federation.js";
import { resetBoundedLogStateForTests } from "../src/lib/bounded-log.js";
import { generateKeyPair } from "../src/lib/crypto.js";

function insertAccount(db: DB, id = "acct1", username = "alice") {
  const keys = generateKeyPair();
  db.prepare("INSERT INTO accounts (id, username, private_key, public_key) VALUES (?, ?, ?, ?)").run(id, username, keys.privateKey, keys.publicKey);
  return { id, username, ...keys };
}

function insertRemoteActor(db: DB, uri = "https://remote.example/users/bob") {
  db.prepare("INSERT INTO remote_actors (uri, type, preferred_username, inbox, outbox, domain) VALUES (?, 'Person', 'bob', ?, ?, 'remote.example')")
    .run(uri, "https://remote.example/inbox", "https://remote.example/users/bob/outbox");
  return uri;
}

function eventObject(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "Event",
    name,
    startTime: "2026-06-01T10:00:00Z",
    attributedTo: "https://remote.example/users/bob",
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetBoundedLogStateForTests();
  delete process.env.SKIP_SIGNATURE_VERIFY;
  delete process.env.OUTBOUND_RETAIN_DELIVERED_DAYS;
  delete process.env.OUTBOUND_RETAIN_FAILED_DAYS;
  delete process.env.OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS;
  delete process.env.INBOX_PROCESSED_RETAIN_DAYS;
  delete process.env.INBOX_FAILED_RETAIN_DAYS;
  delete process.env.INBOX_PROCESSED_MAX_ROWS;
  delete process.env.INBOX_PROCESSED_CLEANUP_INTERVAL_MS;
});

describe("federation hardening prep", () => {
  it("derives, stores, and serializes remote visibility", () => {
    const db = initDatabase(":memory:");
    const actorUri = insertRemoteActor(db);

    upsertRemoteEvent(db, eventObject("https://remote.example/events/unlisted", "Unlisted", {
      to: ["https://remote.example/users/bob/followers"],
      cc: [federation.AP_PUBLIC],
    }), actorUri);

    const row = db.prepare("SELECT re.*, ra.preferred_username, ra.domain FROM remote_events re JOIN remote_actors ra ON ra.uri = re.actor_uri WHERE re.uri = ?")
      .get("https://remote.example/events/unlisted") as Record<string, unknown>;
    expect(row.visibility).toBe("unlisted");
    expect(serializeRemoteEvent(row).visibility).toBe("unlisted");
  });

  it("defaults missing object addressing to public for remote upserts", () => {
    const db = initDatabase(":memory:");
    const actorUri = insertRemoteActor(db);

    upsertRemoteEvent(db, eventObject("https://remote.example/events/no-audience", "No Audience"), actorUri);

    const row = db.prepare("SELECT visibility FROM remote_events WHERE uri = ?")
      .get("https://remote.example/events/no-audience") as { visibility: string };
    expect(row.visibility).toBe("public");
  });

  it("treats explicit empty addressing arrays as private for remote upserts", () => {
    const db = initDatabase(":memory:");
    const actorUri = insertRemoteActor(db);

    upsertRemoteEvent(
      db,
      eventObject("https://remote.example/events/explicit-empty-audience", "Explicit Empty Audience", {
        to: [],
        cc: [],
      }),
      actorUri,
    );

    const row = db.prepare("SELECT visibility FROM remote_events WHERE uri = ?")
      .get("https://remote.example/events/explicit-empty-audience") as { visibility: string };
    expect(row.visibility).toBe("private");
  });

  it("maps outbound audiences distinctly by visibility", () => {
    const actor = "https://local.example/users/alice";
    expect(federation.visibilityToActivityPubAddressing("public", actor)).toEqual({ to: [federation.AP_PUBLIC], cc: [`${actor}/followers`] });
    expect(federation.visibilityToActivityPubAddressing("unlisted", actor)).toEqual({ to: [`${actor}/followers`], cc: [federation.AP_PUBLIC] });
    expect(federation.visibilityToActivityPubAddressing("followers_only", actor)).toEqual({ to: [`${actor}/followers`], cc: [] });
    expect(federation.visibilityToActivityPubAddressing("private", actor)).toEqual({ to: [], cc: [] });
  });

  it("fails closed to private addressing for unknown outbound visibility", () => {
    const actor = "https://local.example/users/alice";
    expect(federation.visibilityToActivityPubAddressing("friends_only", actor)).toEqual({ to: [], cc: [] });
    expect(federation.visibilityToActivityPubAddressing(null, actor)).toEqual({ to: [], cc: [] });
    expect(federation.visibilityToActivityPubAddressing(undefined, actor)).toEqual({ to: [], cc: [] });
  });

  it("derives followers_only only when recipient matches actor followers URL", () => {
    expect(
      federation.deriveVisibilityFromActivityPubAddressing({
        to: [],
        cc: ["https://remote.example/users/bob/followers"],
      }, {
        actorFollowersUrl: "https://remote.example/users/bob/followers",
      })
    ).toBe("followers_only");
  });

  it("treats /followers suffix as private when actor followers URL does not match", () => {
    expect(
      federation.deriveVisibilityFromActivityPubAddressing({
        to: [],
        cc: ["https://remote.example/users/bob/followers"],
      }, {
        actorFollowersUrl: "https://remote.example/actors/bob/subscribers",
      })
    ).toBe("private");
  });

  it("treats direct-recipient addressing as private", () => {
    expect(
      federation.deriveVisibilityFromActivityPubAddressing({
        to: ["https://remote.example/users/alice"],
        cc: [],
      })
    ).toBe("private");
  });

  it("ignores whitespace-only audience values when deriving visibility", () => {
    expect(
      federation.deriveVisibilityFromActivityPubAddressing({
        to: ["   "],
        cc: "\n\t",
      })
    ).toBe("private");
  });

  it("treats only trimmed non-empty audience values as present", () => {
    expect(federation.hasActivityPubAudience("   ")).toBe(false);
    expect(federation.hasActivityPubAudience(" https://remote.example/users/bob ")).toBe(true);
    expect(federation.hasActivityPubAudience(["  ", "\n"])).toBe(false);
    expect(federation.hasActivityPubAudience(["  ", "https://remote.example/users/bob/followers "])).toBe(true);
  });

  it("retries durable outbound deliveries and eventually marks terminal failure", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "try later" }));
    federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/1", type: "Create" },
    });

    await federation.processOutboundDeliveryQueue(db, 1);
    const firstRetry = db.prepare("SELECT next_retry_at FROM outbound_activity_deliveries").get() as {
      next_retry_at: string;
    };
    expect(firstRetry.next_retry_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    for (let i = 0; i < 5; i++) {
      db.prepare("UPDATE outbound_activity_deliveries SET next_retry_at = datetime('now')").run();
      await federation.processOutboundDeliveryQueue(db);
    }

    const row = db.prepare("SELECT state, attempt_count, last_error FROM outbound_activity_deliveries").get() as { state: string; attempt_count: number; last_error: string };
    expect(row.state).toBe("failed");
    expect(row.attempt_count).toBe(5);
    expect(row.last_error).toContain("503 try later");
  });

  it("signs outbound deliveries using the persisted sender key id", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "https://local.example/users/alice",
      activity: { id: "https://local.example/activities/1", type: "Create" },
    });
    db.prepare("UPDATE outbound_activity_deliveries SET sender_key_id = ?").run("https://keys.local.example/alice#v2");

    await federation.processOutboundDeliveryQueue(db, 1);

    const signatureHeader = (fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined)
      ?.headers?.Signature;
    expect(signatureHeader).toContain('keyId="https://keys.local.example/alice#v2"');
  });

  it("falls back to sender actor uri when sender key id is missing", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "https://local.example/users/alice",
      activity: { id: "https://local.example/activities/2", type: "Create" },
    });
    db.prepare("UPDATE outbound_activity_deliveries SET sender_key_id = NULL").run();

    await federation.processOutboundDeliveryQueue(db, 1);

    const signatureHeader = (fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined)
      ?.headers?.Signature;
    expect(signatureHeader).toContain('keyId="https://local.example/users/alice#main-key"');
  });

  it("handles thrown outbound delivery errors without leaving jobs stuck in processing", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    federation.enqueueOutboundDelivery(db, {
      destinationInbox: "ftp://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/throw-1", type: "Create" },
    });

    await federation.processOutboundDeliveryQueue(db, 1);

    const firstAttempt = db.prepare(
      "SELECT state, attempt_count, worker_id, claimed_at, last_error FROM outbound_activity_deliveries"
    ).get() as {
      state: string;
      attempt_count: number;
      worker_id: string | null;
      claimed_at: string | null;
      last_error: string | null;
    };
    expect(firstAttempt.state).toBe("pending");
    expect(firstAttempt.attempt_count).toBe(1);
    expect(firstAttempt.worker_id).toBeNull();
    expect(firstAttempt.claimed_at).toBeNull();
    expect(firstAttempt.last_error).toContain("Invalid protocol");

    for (let i = 0; i < 4; i++) {
      db.prepare("UPDATE outbound_activity_deliveries SET next_retry_at = datetime('now')").run();
      await federation.processOutboundDeliveryQueue(db, 1);
    }

    const finalAttempt = db.prepare("SELECT state, attempt_count, last_error FROM outbound_activity_deliveries").get() as {
      state: string;
      attempt_count: number;
      last_error: string | null;
    };
    expect(finalAttempt.state).toBe("failed");
    expect(finalAttempt.attempt_count).toBe(5);
    expect(finalAttempt.last_error).toContain("Invalid protocol");
  });

  it("times out stalled outbound deliveries and records timeout in last_error", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }));

      federation.enqueueOutboundDelivery(db, {
        destinationInbox: "https://remote.example/inbox",
        senderAccountId: account.id,
        senderActorUri: "http://localhost:3000/users/alice",
        activity: { id: "http://localhost/activity/timeout-1", type: "Create" },
      });

    await federation.processOutboundDeliveryQueue(db, 1);

      const row = db.prepare("SELECT state, attempt_count, worker_id, claimed_at, last_error FROM outbound_activity_deliveries").get() as {
        state: string;
        attempt_count: number;
        worker_id: string | null;
        claimed_at: string | null;
        last_error: string | null;
      };

      expect(row.state).toBe("pending");
      expect(row.attempt_count).toBe(1);
      expect(row.worker_id).toBeNull();
      expect(row.claimed_at).toBeNull();
    expect(row.last_error).toContain("timed out after 120000ms");
  });

  it("coalesces overlapping outbound queue runners in process", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    let resolveFetch: (() => void) | null = null;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      resolveFetch = () => resolve({ ok: true, status: 202, text: async () => "" });
    }));
    vi.stubGlobal("fetch", fetchMock);

    federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://93.184.216.34/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/single-flight", type: "Create" },
    });

    const run1 = federation.processOutboundDeliveryQueue(db, 1);
    const run2 = federation.processOutboundDeliveryQueue(db, 1);
    for (let i = 0; i < 20 && fetchMock.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveFetch).not.toBeNull();
    resolveFetch?.();

    const [result1, result2] = await Promise.all([run1, run2]);
    expect(result1).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(result2).toEqual({ processed: 1, delivered: 1, failed: 0 });
  });

  it("does not coalesce overlapping outbound queue runners across different db handles", async () => {
    const db1 = initDatabase(":memory:");
    const db2 = initDatabase(":memory:");
    const account1 = insertAccount(db1);
    const account2 = insertAccount(db2);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    federation.enqueueOutboundDelivery(db1, {
      destinationInbox: "https://93.184.216.34/inbox",
      senderAccountId: account1.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/db-1", type: "Create" },
    });
    federation.enqueueOutboundDelivery(db2, {
      destinationInbox: "https://93.184.216.35/inbox",
      senderAccountId: account2.id,
      senderActorUri: "http://localhost:3000/users/bob",
      activity: { id: "http://localhost/activity/db-2", type: "Create" },
    });

    const [result1, result2] = await Promise.all([
      federation.processOutboundDeliveryQueue(db1, 1),
      federation.processOutboundDeliveryQueue(db2, 1),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result1).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(result2).toEqual({ processed: 1, delivered: 1, failed: 0 });

    const row1 = db1.prepare("SELECT state FROM outbound_activity_deliveries LIMIT 1").get() as { state: string };
    const row2 = db2.prepare("SELECT state FROM outbound_activity_deliveries LIMIT 1").get() as { state: string };
    expect(row1.state).toBe("delivered");
    expect(row2.state).toBe("delivered");
  });

  it("atomically claims pending jobs and recovers stale processing claims", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => "" }));

    const activeClaimId = federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/active-claim", type: "Create" },
    });
    const staleClaimId = federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/stale-claim", type: "Create" },
    });

    db.prepare(
      "UPDATE outbound_activity_deliveries SET state = 'processing', worker_id = ?, claimed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run("other-worker", activeClaimId);
    db.prepare(
      "UPDATE outbound_activity_deliveries SET state = 'processing', worker_id = ?, claimed_at = datetime('now', '-20 minutes'), updated_at = datetime('now') WHERE id = ?"
    ).run("dead-worker", staleClaimId);

    const result = await federation.processOutboundDeliveryQueue(db, 5);
    expect(result.processed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    const activeClaim = db.prepare("SELECT state FROM outbound_activity_deliveries WHERE id = ?").get(activeClaimId) as { state: string };
    expect(activeClaim.state).toBe("processing");

    const staleClaim = db.prepare("SELECT state, attempt_count, worker_id, claimed_at FROM outbound_activity_deliveries WHERE id = ?").get(staleClaimId) as {
      state: string;
      attempt_count: number;
      worker_id: string | null;
      claimed_at: string | null;
    };
    expect(staleClaim.state).toBe("delivered");
    expect(staleClaim.attempt_count).toBe(1);
    expect(staleClaim.worker_id).toBeNull();
    expect(staleClaim.claimed_at).toBeNull();
  });

  it("does not claim pending jobs already tagged to another worker", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => "" }));

    const externallyTaggedPendingId = federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/tagged-pending", type: "Create" },
    });
    const claimablePendingId = federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/claimable-pending", type: "Create" },
    });

    db.prepare("UPDATE outbound_activity_deliveries SET worker_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run("other-worker", externallyTaggedPendingId);

    const result = await federation.processOutboundDeliveryQueue(db, 5);
    expect(result.processed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    const externallyTaggedPending = db.prepare(
      "SELECT state, worker_id, claimed_at, attempt_count FROM outbound_activity_deliveries WHERE id = ?"
    ).get(externallyTaggedPendingId) as {
      state: string;
      worker_id: string | null;
      claimed_at: string | null;
      attempt_count: number;
    };
    expect(externallyTaggedPending.state).toBe("pending");
    expect(externallyTaggedPending.worker_id).toBe("other-worker");
    expect(externallyTaggedPending.claimed_at).toBeNull();
    expect(externallyTaggedPending.attempt_count).toBe(0);

    const claimablePending = db.prepare(
      "SELECT state, worker_id, claimed_at, attempt_count FROM outbound_activity_deliveries WHERE id = ?"
    ).get(claimablePendingId) as {
      state: string;
      worker_id: string | null;
      claimed_at: string | null;
      attempt_count: number;
    };
    expect(claimablePending.state).toBe("delivered");
    expect(claimablePending.worker_id).toBeNull();
    expect(claimablePending.claimed_at).toBeNull();
    expect(claimablePending.attempt_count).toBe(1);
  });

  it("skips outbound queue processing when there are no follower inboxes", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    const jobId = federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/stale-not-claimed", type: "Create" },
    });

    db.prepare(
      "UPDATE outbound_activity_deliveries SET state = 'processing', worker_id = ?, claimed_at = datetime('now', '-20 minutes'), updated_at = datetime('now') WHERE id = ?"
    ).run("dead-worker", jobId);

    await federation.deliverToFollowers(db, account.id, { id: "http://localhost/activity/no-followers", type: "Create" });

    const unchanged = db.prepare(
      "SELECT state, worker_id, claimed_at FROM outbound_activity_deliveries WHERE id = ?"
    ).get(jobId) as { state: string; worker_id: string | null; claimed_at: string | null };
    expect(unchanged.state).toBe("processing");
    expect(unchanged.worker_id).toBe("dead-worker");
    expect(unchanged.claimed_at).not.toBeNull();
  });

  it("uses strict numeric parsing for outbound worker interval", () => {
    const db = initDatabase(":memory:");
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockImplementation(() => 1 as unknown as NodeJS.Timeout);

    process.env.OUTBOUND_DELIVERY_INTERVAL_MS = "30000ms";
    federation.startOutboundDeliveryWorker(db);
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 30000);

    process.env.OUTBOUND_DELIVERY_INTERVAL_MS = "999";
    federation.startOutboundDeliveryWorker(db);
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);

    process.env.OUTBOUND_DELIVERY_INTERVAL_MS = "1500";
    federation.startOutboundDeliveryWorker(db);
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 1500);
  });

  it("cleans up old terminal outbound deliveries with defaults", () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);

    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run(
      "old-delivered",
      "https://remote.example/inbox",
      account.id,
      "http://localhost:3000/users/alice",
      "http://localhost:3000/users/alice#main-key",
      JSON.stringify({ id: "old-delivered" }),
      "delivered",
      "-31 days"
    );
    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run(
      "old-failed",
      "https://remote.example/inbox",
      account.id,
      "http://localhost:3000/users/alice",
      "http://localhost:3000/users/alice#main-key",
      JSON.stringify({ id: "old-failed" }),
      "failed",
      "-91 days"
    );
    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run(
      "recent-delivered",
      "https://remote.example/inbox",
      account.id,
      "http://localhost:3000/users/alice",
      "http://localhost:3000/users/alice#main-key",
      JSON.stringify({ id: "recent-delivered" }),
      "delivered",
      "-5 days"
    );
    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run(
      "pending-row",
      "https://remote.example/inbox",
      account.id,
      "http://localhost:3000/users/alice",
      "http://localhost:3000/users/alice#main-key",
      JSON.stringify({ id: "pending-row" }),
      "pending",
      "-365 days"
    );

    const result = federation.cleanupTerminalOutboundDeliveries(db);
    expect(result).toEqual({ deletedDelivered: 1, deletedFailed: 1 });

    const remainingIds = db
      .prepare("SELECT id FROM outbound_activity_deliveries ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remainingIds.map((row) => row.id)).toEqual(["pending-row", "recent-delivered"]);
  });

  it("uses strict numeric parsing for terminal outbound cleanup configuration", () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockImplementation(() => 1 as unknown as NodeJS.Timeout);

    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run(
      "keep-delivered",
      "https://remote.example/inbox",
      account.id,
      "http://localhost:3000/users/alice",
      "http://localhost:3000/users/alice#main-key",
      JSON.stringify({ id: "keep-delivered" }),
      "delivered",
      "-4 days"
    );
    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run(
      "delete-delivered",
      "https://remote.example/inbox",
      account.id,
      "http://localhost:3000/users/alice",
      "http://localhost:3000/users/alice#main-key",
      JSON.stringify({ id: "delete-delivered" }),
      "delivered",
      "-5 days"
    );
    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run(
      "delete-failed",
      "https://remote.example/inbox",
      account.id,
      "http://localhost:3000/users/alice",
      "http://localhost:3000/users/alice#main-key",
      JSON.stringify({ id: "delete-failed" }),
      "failed",
      "-1 days"
    );

    process.env.OUTBOUND_RETAIN_DELIVERED_DAYS = "4.8";
    process.env.OUTBOUND_RETAIN_FAILED_DAYS = "-12";
    process.env.OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS = "5000ms";

    federation.startOutboundTerminalCleanupWorker(db);

    const remainingIds = db
      .prepare("SELECT id FROM outbound_activity_deliveries ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remainingIds.map((row) => row.id)).toEqual(["keep-delivered"]);
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 3600000);
  });

  it("re-reads outbound cleanup retention settings on each worker run", () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    let intervalRun: (() => void) | null = null;
    vi.spyOn(global, "setInterval").mockImplementation((fn: TimerHandler) => {
      intervalRun = fn as () => void;
      return 1 as unknown as NodeJS.Timeout;
    });

    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run("older", "https://remote.example/inbox", account.id, "http://localhost:3000/users/alice", "http://localhost:3000/users/alice#main-key", JSON.stringify({ id: "older" }), "delivered", "-5 days");
    db.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))"
    ).run("recent", "https://remote.example/inbox", account.id, "http://localhost:3000/users/alice", "http://localhost:3000/users/alice#main-key", JSON.stringify({ id: "recent" }), "delivered", "-4 days");

    db.prepare("INSERT INTO admin_settings (key, value_json) VALUES (?, ?)").run("outbound_retain_delivered_days", JSON.stringify(4));
    federation.startOutboundTerminalCleanupWorker(db);
    expect(intervalRun).toBeTypeOf("function");

    let remainingIds = db.prepare("SELECT id FROM outbound_activity_deliveries ORDER BY id").all() as Array<{ id: string }>;
    expect(remainingIds.map((row) => row.id)).toEqual(["recent"]);

    db.prepare("INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))")
      .run("recent-2", "https://remote.example/inbox", account.id, "http://localhost:3000/users/alice", "http://localhost:3000/users/alice#main-key", JSON.stringify({ id: "recent-2" }), "delivered", "-4 days");
    db.prepare("INSERT INTO admin_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
      .run("outbound_retain_delivered_days", JSON.stringify(10));

    intervalRun?.();

    remainingIds = db.prepare("SELECT id FROM outbound_activity_deliveries ORDER BY id").all() as Array<{ id: string }>;
    expect(remainingIds.map((row) => row.id)).toEqual(["recent", "recent-2"]);
  });

  it("cleans up old terminal processed inbox rows with defaults", () => {
    const db = initDatabase(":memory:");

    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("processed-old", "https://remote.example/users/bob", "user:alice", "processed", "-31 days");
    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("failed-old", "https://remote.example/users/bob", "user:alice", "failed", "-91 days");
    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("processed-recent", "https://remote.example/users/bob", "user:alice", "processed", "-1 days");
    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("processing-keep", "https://remote.example/users/bob", "user:alice", "processing", "-365 days");

    const result = federation.cleanupProcessedInboxActivities(db);
    expect(result).toEqual({ deletedProcessed: 1, deletedFailed: 1, deletedCapped: 0 });

    const remainingIds = db
      .prepare("SELECT activity_id FROM processed_inbox_activities ORDER BY activity_id")
      .all() as Array<{ activity_id: string }>;
    expect(remainingIds.map((row) => row.activity_id)).toEqual(["processed-recent", "processing-keep"]);
  });

  it("applies inbox dedupe cap and strict numeric cleanup parsing", () => {
    const db = initDatabase(":memory:");
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockImplementation(() => 1 as unknown as NodeJS.Timeout);

    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("oldest", "https://remote.example/users/bob", "user:alice", "processed", "-10 days");
    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("middle", "https://remote.example/users/bob", "user:alice", "failed", "-5 days");
    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("newest", "https://remote.example/users/bob", "user:alice", "processed", "-1 days");

    process.env.INBOX_PROCESSED_RETAIN_DAYS = "400";
    process.env.INBOX_FAILED_RETAIN_DAYS = "400";
    process.env.INBOX_PROCESSED_MAX_ROWS = "2.9";
    process.env.INBOX_PROCESSED_CLEANUP_INTERVAL_MS = "5000ms";

    federation.startProcessedInboxCleanupWorker(db);

    const remainingIds = db
      .prepare("SELECT activity_id FROM processed_inbox_activities ORDER BY activity_id")
      .all() as Array<{ activity_id: string }>;
    expect(remainingIds.map((row) => row.activity_id)).toEqual(["middle", "newest"]);
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 3600000);
  });

  it("re-reads inbox cleanup settings on each worker run", () => {
    const db = initDatabase(":memory:");
    let intervalRun: (() => void) | null = null;
    vi.spyOn(global, "setInterval").mockImplementation((fn: TimerHandler) => {
      intervalRun = fn as () => void;
      return 1 as unknown as NodeJS.Timeout;
    });

    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("a", "https://remote.example/users/bob", "user:alice", "processed", "-10 days");
    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("b", "https://remote.example/users/bob", "user:alice", "processed", "-5 days");

    db.prepare("INSERT INTO admin_settings (key, value_json) VALUES (?, ?)").run("inbox_processed_retain_days", JSON.stringify(1));
    federation.startProcessedInboxCleanupWorker(db);
    expect(intervalRun).toBeTypeOf("function");

    let remainingIds = db.prepare("SELECT activity_id FROM processed_inbox_activities ORDER BY activity_id").all() as Array<{ activity_id: string }>;
    expect(remainingIds).toEqual([]);

    db.prepare(
      `INSERT INTO processed_inbox_activities
       (activity_id, actor_uri, target_context, status, received_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`
    ).run("c", "https://remote.example/users/bob", "user:alice", "processed", "-5 days");
    db.prepare("INSERT INTO admin_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
      .run("inbox_processed_retain_days", JSON.stringify(10));

    intervalRun?.();

    remainingIds = db.prepare("SELECT activity_id FROM processed_inbox_activities ORDER BY activity_id").all() as Array<{ activity_id: string }>;
    expect(remainingIds.map((row) => row.activity_id)).toEqual(["c"]);
  });

  it("skips duplicate inbox activities with stable ids", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = (name: string) => ({
      id: "https://remote.example/activities/create-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/dupe", name, { to: [federation.AP_PUBLIC] }),
    });

    expect((await app.request("http://localhost/users/alice/inbox", { method: "POST", body: JSON.stringify(activity("First")) })).status).toBe(202);
    const second = await app.request("http://localhost/users/alice/inbox", { method: "POST", body: JSON.stringify(activity("Second")) });
    expect(second.status).toBe(202);
    expect((await second.json() as { duplicate?: boolean }).duplicate).toBe(true);
    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/dupe") as { title: string };
    expect(row.title).toBe("First");
  });

  it("accepts user inbox activity when actor is an object with id", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-non-string-actor",
        type: "Create",
        actor: { id: "https://remote.example/users/bob" },
        object: eventObject("https://remote.example/events/non-string-actor", "Should Accept", { to: [federation.AP_PUBLIC] }),
      }),
    });

    expect(response.status).toBe(202);
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("trims user inbox actor string before processing", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = {
      id: "https://remote.example/activities/create-trimmed-actor",
      type: "Create",
      actor: "  https://remote.example/users/bob\n",
      object: eventObject("https://remote.example/events/trimmed-actor", "Trimmed Actor", { to: [federation.AP_PUBLIC] }),
    };

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(response.status).toBe(202);

    const dedupeRow = db.prepare(
      "SELECT actor_uri FROM processed_inbox_activities WHERE activity_id = ? AND target_context = ?"
    ).get(activity.id, "user:alice") as { actor_uri: string };
    expect(dedupeRow.actor_uri).toBe("https://remote.example/users/bob");
  });

  it("stores Follow state with trimmed actor URI", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: "https://remote.example/users/bob",
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: null,
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "deliverActivity").mockResolvedValue(true);

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/follow-trimmed-actor",
        type: "Follow",
        actor: "  https://remote.example/users/bob\n",
        object: "http://localhost/users/alice",
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare(
      "SELECT follower_actor_uri FROM remote_follows WHERE account_id = ?"
    ).get("local1") as { follower_actor_uri: string };
    expect(row.follower_actor_uri).toBe("https://remote.example/users/bob");
  });

  it("uses trimmed actor URI when handling Undo Follow", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    db.prepare(
      "INSERT INTO remote_follows (account_id, follower_actor_uri, follower_inbox) VALUES (?, ?, ?)"
    ).run("local1", "https://remote.example/users/bob", "https://remote.example/inbox");

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/undo-trimmed-actor",
        type: "Undo",
        actor: "  https://remote.example/users/bob\n",
        object: {
          type: "Follow",
          actor: "https://remote.example/users/bob",
          object: "http://localhost/users/alice",
        },
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM remote_follows WHERE account_id = ?"
    ).get("local1") as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it("treats trimmed activity id as the dedupe key in user inbox", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const first = {
      id: "  https://remote.example/activities/create-trimmed-id-1\n",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/trimmed-id", "First payload", { to: [federation.AP_PUBLIC] }),
    };

    const second = {
      id: "https://remote.example/activities/create-trimmed-id-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/trimmed-id", "Second payload", { to: [federation.AP_PUBLIC] }),
    };

    const firstResponse = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(first),
    });
    expect(firstResponse.status).toBe(202);

    const secondResponse = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(second),
    });
    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json() as { duplicate?: boolean }).toEqual({ ok: true, duplicate: true });

    const row = db.prepare(
      "SELECT activity_id FROM processed_inbox_activities WHERE actor_uri = ? AND target_context = ?"
    ).get("https://remote.example/users/bob", "user:alice") as { activity_id: string };
    expect(row.activity_id).toBe("https://remote.example/activities/create-trimmed-id-1");

    const event = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/trimmed-id") as { title: string };
    expect(event.title).toBe("First payload");
  });

  it("marks inbox activity failed and allows retry after processing failure", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = {
      id: "https://remote.example/activities/create-retry-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/retry", "Recovered", { to: [federation.AP_PUBLIC] }),
    };

    const realUpsert = remoteEvents.upsertRemoteEvent;
    const upsertSpy = vi.spyOn(remoteEvents, "upsertRemoteEvent");
    upsertSpy.mockImplementationOnce(() => {
      throw new Error("transient failure");
    });
    upsertSpy.mockImplementation(realUpsert);

    const first = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(first.status).toBe(500);

    const second = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: true });

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/retry") as { title: string };
    expect(row.title).toBe("Recovered");

    const dedupeRow = db.prepare(
      "SELECT status, claimed_at, processed_at, last_error FROM processed_inbox_activities WHERE activity_id = ? AND actor_uri = ? AND target_context = ?"
    ).get(
      activity.id,
      activity.actor,
      "user:alice"
    ) as { status: string; claimed_at: string | null; processed_at: string | null; last_error: string | null };
    expect(dedupeRow.status).toBe("processed");
    expect(dedupeRow.claimed_at).toBeNull();
    expect(dedupeRow.processed_at).toBeTruthy();
    expect(dedupeRow.last_error).toBeNull();
  });

  it("skips duplicate shared inbox activities with stable ids", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/", sharedInboxRoute(db));

    const activity = (name: string) => ({
      id: "https://remote.example/activities/shared-create-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/shared-dupe", name, { to: [federation.AP_PUBLIC] }),
    });

    expect((await app.request("http://localhost/inbox", { method: "POST", body: JSON.stringify(activity("First")) })).status).toBe(202);
    const second = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify(activity("Second")),
    });
    expect(second.status).toBe(202);
    expect((await second.json() as { duplicate?: boolean }).duplicate).toBe(true);
    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/shared-dupe") as { title: string };
    expect(row.title).toBe("First");
  });

  it("rejects shared inbox activity when actor is empty after trimming", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const app = new Hono();
    app.route("/", sharedInboxRoute(db));

    const response = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/shared-create-empty-actor",
        type: "Create",
        actor: "   \n\t",
        object: eventObject("https://remote.example/events/shared-empty-actor", "Should Reject", { to: [federation.AP_PUBLIC] }),
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("marks shared inbox activity failed and allows retry after processing failure", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/", sharedInboxRoute(db));

    const activity = {
      id: "https://remote.example/activities/shared-create-retry-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/shared-retry", "Recovered", { to: [federation.AP_PUBLIC] }),
    };

    const realUpsert = remoteEvents.upsertRemoteEvent;
    const upsertSpy = vi.spyOn(remoteEvents, "upsertRemoteEvent");
    upsertSpy.mockImplementationOnce(() => {
      throw new Error("transient failure");
    });
    upsertSpy.mockImplementation(realUpsert);

    const first = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(first.status).toBe(500);

    const second = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: true });

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/shared-retry") as { title: string };
    expect(row.title).toBe("Recovered");

    const dedupeRow = db.prepare(
      "SELECT status, claimed_at, processed_at, last_error FROM processed_inbox_activities WHERE activity_id = ? AND actor_uri = ? AND target_context = ?"
    ).get(
      activity.id,
      activity.actor,
      "shared:inbox"
    ) as { status: string; claimed_at: string | null; processed_at: string | null; last_error: string | null };
    expect(dedupeRow.status).toBe("processed");
    expect(dedupeRow.claimed_at).toBeNull();
    expect(dedupeRow.processed_at).toBeTruthy();
    expect(dedupeRow.last_error).toBeNull();
  });

  it("reclaims stale inbox processing claims", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = {
      id: "https://remote.example/activities/create-stale-claim-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/stale-claim", "Recovered from stale claim", { to: [federation.AP_PUBLIC] }),
    };

    db.prepare(
      `INSERT INTO processed_inbox_activities
         (activity_id, actor_uri, target_context, status, claimed_at, received_at)
       VALUES (?, ?, ?, 'processing', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`
    ).run(activity.id, activity.actor, "user:alice");

    const before = db.prepare(
      "SELECT received_at FROM processed_inbox_activities WHERE activity_id = ? AND actor_uri = ? AND target_context = ?"
    ).get(activity.id, activity.actor, "user:alice") as { received_at: string };

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(response.status).toBe(202);

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/stale-claim") as { title: string };
    expect(row.title).toBe("Recovered from stale claim");

    const after = db.prepare(
      "SELECT status, received_at FROM processed_inbox_activities WHERE activity_id = ? AND actor_uri = ? AND target_context = ?"
    ).get(activity.id, activity.actor, "user:alice") as { status: string; received_at: string };
    expect(after.status).toBe("processed");
    expect(after.received_at).toBe(before.received_at);
  });

  it("keeps received_at unchanged when inbox processing fails", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = {
      id: "https://remote.example/activities/create-failure-preserves-received-at",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/failure-preserves-received-at", "Will fail", { to: [federation.AP_PUBLIC] }),
    };

    db.prepare(
      `INSERT INTO processed_inbox_activities
         (activity_id, actor_uri, target_context, status, claimed_at, received_at)
       VALUES (?, ?, ?, 'processing', datetime('now', '-10 minutes'), '2001-02-03 04:05:06')`
    ).run(activity.id, activity.actor, "user:alice");

    const upsertSpy = vi.spyOn(remoteEvents, "upsertRemoteEvent");
    upsertSpy.mockImplementationOnce(() => {
      throw new Error("still failing");
    });

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(response.status).toBe(500);

    const row = db.prepare(
      "SELECT status, claimed_at, processed_at, last_error, received_at FROM processed_inbox_activities WHERE activity_id = ? AND actor_uri = ? AND target_context = ?"
    ).get(activity.id, activity.actor, "user:alice") as {
      status: string;
      claimed_at: string | null;
      processed_at: string | null;
      last_error: string | null;
      received_at: string;
    };
    expect(row.status).toBe("failed");
    expect(row.claimed_at).toBeNull();
    expect(row.processed_at).toBeNull();
    expect(row.last_error).toContain("still failing");
    expect(row.received_at).toBe("2001-02-03 04:05:06");
  });

  it("does not reclaim fresh inbox processing claims", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = {
      id: "https://remote.example/activities/create-fresh-claim-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/fresh-claim", "Should be skipped", { to: [federation.AP_PUBLIC] }),
    };

    db.prepare(
      `INSERT INTO processed_inbox_activities
         (activity_id, actor_uri, target_context, status, claimed_at, received_at)
       VALUES (?, ?, ?, 'processing', datetime('now'), datetime('now'))`
    ).run(activity.id, activity.actor, "user:alice");

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(response.status).toBe(202);
    expect((await response.json() as { duplicate?: boolean }).duplicate).toBe(true);

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/fresh-claim");
    expect(row).toBeUndefined();
  });

  it("skips user inbox Create when Event object.id is not a non-empty string", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-invalid-object-id",
        type: "Create",
        actor: "https://remote.example/users/bob",
        object: {
          id: { value: "https://remote.example/events/invalid" },
          type: "Event",
          name: "Invalid Object Id",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: "https://remote.example/users/bob",
          to: [federation.AP_PUBLIC],
        },
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledWith(
      "  ⚠️  Skipping Create: Event object.id is missing or not a non-empty string"
    );

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("skips shared inbox Update when Event object.id is missing", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/", sharedInboxRoute(db));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/update-missing-object-id",
        type: "Update",
        actor: "https://remote.example/users/bob",
        object: {
          type: "Event",
          name: "Missing Object Id",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: "https://remote.example/users/bob",
          to: [federation.AP_PUBLIC],
        },
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledWith(
      "  ⚠️  Skipping Update: Event object.id is missing or not a non-empty string"
    );

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("normalizes whitespace around user inbox Event object.id", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const eventId = "https://remote.example/events/trimmed-id";
    const createRes = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-trimmed-id",
        type: "Create",
        actor: "https://remote.example/users/bob",
        object: {
          id: `  ${eventId}  `,
          type: "Event",
          name: "Trimmed Create",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: "https://remote.example/users/bob",
          to: [federation.AP_PUBLIC],
        },
      }),
    });
    expect(createRes.status).toBe(202);

    const updateRes = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/update-trimmed-id",
        type: "Update",
        actor: "https://remote.example/users/bob",
        object: {
          id: eventId,
          type: "Event",
          name: "Trimmed Update",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: "https://remote.example/users/bob",
          to: [federation.AP_PUBLIC],
        },
      }),
    });
    expect(updateRes.status).toBe(202);

    const rows = db.prepare("SELECT uri, title FROM remote_events WHERE uri = ?").all(eventId) as Array<{ uri: string; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ uri: eventId, title: "Trimmed Update" });
    const total = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events").get() as { cnt: number };
    expect(total.cnt).toBe(1);
  });

  it("uses normalized actor URI for user inbox Create ownership persistence", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const actorUri = insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const eventId = "https://remote.example/events/trimmed-actor-create";
    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-trimmed-actor",
        type: "Create",
        actor: `  ${actorUri}  `,
        object: {
          id: eventId,
          type: "Event",
          name: "Trimmed Actor Create",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: actorUri,
          to: [federation.AP_PUBLIC],
        },
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare("SELECT actor_uri FROM remote_events WHERE uri = ?").get(eventId) as { actor_uri: string } | undefined;
    expect(row?.actor_uri).toBe(actorUri);
  });

  it("uses normalized actor URI for user inbox Delete ownership checks", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const actorUri = insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const eventId = "https://remote.example/events/trimmed-actor-delete";
    upsertRemoteEvent(db, eventObject(eventId, "Delete Target", { to: [federation.AP_PUBLIC] }), actorUri);

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/delete-trimmed-actor",
        type: "Delete",
        actor: `  ${actorUri}  `,
        object: eventId,
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare("SELECT canceled FROM remote_events WHERE uri = ?").get(eventId) as { canceled: number } | undefined;
    expect(row?.canceled).toBe(1);
  });

  it("accepts user inbox Create when attributedTo is an object with id", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const actorUri = insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const eventId = "https://remote.example/events/object-attributed-inbox";
    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-object-attributed-inbox",
        type: "Create",
        actor: actorUri,
        object: {
          id: eventId,
          type: "Event",
          name: "Object attributedTo",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: { id: actorUri },
          to: [federation.AP_PUBLIC],
        },
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare("SELECT uri, actor_uri FROM remote_events WHERE uri = ?").get(eventId) as
      | { uri: string; actor_uri: string }
      | undefined;
    expect(row).toEqual({ uri: eventId, actor_uri: actorUri });
  });

  it("accepts user inbox Create when attributedTo array contains object id", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const actorUri = insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const eventId = "https://remote.example/events/array-object-attributed-inbox";
    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-array-object-attributed-inbox",
        type: "Create",
        actor: actorUri,
        object: {
          id: eventId,
          type: "Event",
          name: "Array object attributedTo",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: [{ type: "Person" }, { id: actorUri }],
          to: [federation.AP_PUBLIC],
        },
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare("SELECT uri, actor_uri FROM remote_events WHERE uri = ?").get(eventId) as
      | { uri: string; actor_uri: string }
      | undefined;
    expect(row).toEqual({ uri: eventId, actor_uri: actorUri });
  });

  it("rejects user inbox Create when attributedTo resolves to different actor", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const actorUri = insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-mismatch-attributed-inbox",
        type: "Create",
        actor: actorUri,
        object: {
          id: "https://remote.example/events/mismatch-attributed-inbox",
          type: "Event",
          name: "Mismatched attributedTo",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: { id: "https://remote.example/users/carol" },
          to: [federation.AP_PUBLIC],
        },
      }),
    });

    expect(response.status).toBe(202);
    expect(logSpy).toHaveBeenCalledWith(
      `  ⚠️  Rejecting Create/Update: actor ${actorUri} != attributedTo https://remote.example/users/carol`
    );
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("rejects user inbox Create for blocked actors", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const actorUri = insertRemoteActor(db);
    db.prepare(
      `INSERT INTO federation_blocks (id, block_type, actor_uri, reason, created_by_account_id, is_active)
       VALUES ('block-actor', 'actor', ?, 'blocked', 'admin-1', 1)`
    ).run(actorUri);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-blocked-inbox",
        type: "Create",
        actor: actorUri,
        object: {
          id: "https://remote.example/events/blocked-inbox",
          type: "Event",
          name: "Blocked Inbox Event",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: actorUri,
          to: [federation.AP_PUBLIC],
        },
      }),
    });

    expect(response.status).toBe(202);
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events WHERE uri = ?").get("https://remote.example/events/blocked-inbox") as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("uses activity addressing when Event object has no to/cc", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const eventId = "https://remote.example/events/activity-addressing";
    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/create-activity-addressing",
        type: "Create",
        actor: "https://remote.example/users/bob",
        to: ["https://remote.example/users/bob/followers"],
        cc: [federation.AP_PUBLIC],
        object: {
          id: eventId,
          type: "Event",
          name: "Audience From Activity",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: "https://remote.example/users/bob",
        },
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare("SELECT visibility FROM remote_events WHERE uri = ?").get(eventId) as { visibility: string };
    expect(row.visibility).toBe("unlisted");
  });

  it("pull import processes Update and Delete with actor ownership checks", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    upsertRemoteEvent(db, eventObject("https://remote.example/events/pulled", "Old", { to: [federation.AP_PUBLIC] }), actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    const fetchOutboxSpy = vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      { id: "https://remote.example/activities/update", type: "Update", actor: actorUri, object: eventObject("https://remote.example/events/pulled", "New", { to: ["https://remote.example/users/bob/followers"], cc: [federation.AP_PUBLIC] }) },
      { id: "https://remote.example/activities/delete", type: "Delete", actor: actorUri, object: "https://remote.example/events/pulled" },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT title, visibility, canceled FROM remote_events WHERE uri = ?").get("https://remote.example/events/pulled") as { title: string; visibility: string; canceled: number };
    expect(row).toEqual({ title: "New", visibility: "unlisted", canceled: 1 });
  });

  it("treats explicit empty activity to/cc as private during pull import", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    upsertRemoteEvent(db, eventObject("https://remote.example/events/explicit-private", "Old", { to: [federation.AP_PUBLIC] }), actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/update-explicit-private",
        type: "Update",
        actor: actorUri,
        to: [],
        cc: [],
        object: eventObject("https://remote.example/events/explicit-private", "Now Private"),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT visibility FROM remote_events WHERE uri = ?").get("https://remote.example/events/explicit-private") as { visibility: string };
    expect(row.visibility).toBe("private");
  });

  it("skips pulled imports for blocked actors", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    db.prepare(
      `INSERT INTO federation_blocks (id, block_type, actor_uri, reason, created_by_account_id, is_active)
       VALUES ('block-actor', 'actor', ?, 'blocked', 'admin-1', 1)`
    ).run(actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/create-blocked-pull",
        type: "Create",
        actor: actorUri,
        object: eventObject("https://remote.example/events/blocked-pull", "Blocked Pull Event", { to: [federation.AP_PUBLIC] }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { imported: number };
    expect(body.imported).toBe(0);
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events WHERE uri = ?").get("https://remote.example/events/blocked-pull") as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("treats explicit empty activity to/cc as private during user inbox Update", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    const actorUri = insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const eventUri = "https://remote.example/events/explicit-private-inbox";
    upsertRemoteEvent(
      db,
      eventObject(eventUri, "Initially Public", { to: [federation.AP_PUBLIC] }),
      actorUri,
    );

    const response = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify({
        id: "https://remote.example/activities/update-explicit-private-inbox",
        type: "Update",
        actor: actorUri,
        to: [],
        cc: [],
        object: eventObject(eventUri, "Now Private"),
      }),
    });

    expect(response.status).toBe(202);
    const row = db.prepare("SELECT visibility FROM remote_events WHERE uri = ?").get(eventUri) as { visibility: string };
    expect(row.visibility).toBe("private");
  });

  it("accepts pulled Update when attributedTo is an object with id", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    upsertRemoteEvent(db, eventObject("https://remote.example/events/object-attributed", "Old", { to: [federation.AP_PUBLIC] }), actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/update-object-attributed",
        type: "Update",
        actor: actorUri,
        object: eventObject("https://remote.example/events/object-attributed", "New", {
          attributedTo: { id: actorUri },
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 1, total: 1 });

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/object-attributed") as { title: string };
    expect(row.title).toBe("New");
  });

  it("accepts pulled Update when activity.actor is an object with id", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    upsertRemoteEvent(db, eventObject("https://remote.example/events/object-actor", "Old", { to: [federation.AP_PUBLIC] }), actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/update-object-actor",
        type: "Update",
        actor: { id: actorUri },
        object: eventObject("https://remote.example/events/object-actor", "New", {
          attributedTo: actorUri,
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 1, total: 1 });

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/object-actor") as { title: string };
    expect(row.title).toBe("New");
  });

  it("rejects pulled Update when attributedTo is present but unparseable", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    upsertRemoteEvent(db, eventObject("https://remote.example/events/unparseable-attributed", "Old", { to: [federation.AP_PUBLIC] }), actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/update-unparseable-attributed",
        type: "Update",
        actor: actorUri,
        object: eventObject("https://remote.example/events/unparseable-attributed", "Should Be Ignored", {
          attributedTo: [{ type: "Person" }],
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/unparseable-attributed") as { title: string };
    expect(row.title).toBe("Old");
  });

  it("rejects pulled Create when attributedTo is present but unparseable", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/create-unparseable-attributed",
        type: "Create",
        actor: actorUri,
        object: eventObject("https://remote.example/events/unparseable-create", "Should Be Rejected", {
          attributedTo: [{ type: "Person" }],
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events WHERE uri = ?").get("https://remote.example/events/unparseable-create") as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("imports pulled Announce and stores attributedTo actor as owner when present", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const announcerUri = insertRemoteActor(db);
    const originalActorUri = insertRemoteActor(db, "https://remote.example/users/carol");

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: announcerUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/announce-1",
        type: "Announce",
        actor: announcerUri,
        object: eventObject("https://remote.example/events/boosted-1", "Boosted event", {
          attributedTo: originalActorUri,
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri: announcerUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 1, total: 1 });

    const row = db.prepare("SELECT actor_uri, title FROM remote_events WHERE uri = ?").get("https://remote.example/events/boosted-1") as {
      actor_uri: string;
      title: string;
    };
    expect(row).toEqual({ actor_uri: originalActorUri, title: "Boosted event" });
  });

  it("does not reassign owner for existing event on pulled Announce with different attributedTo", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const announcerUri = insertRemoteActor(db);
    const existingOwnerUri = insertRemoteActor(db, "https://remote.example/users/carol");
    const differentAttributedUri = insertRemoteActor(db, "https://remote.example/users/dave");
    const eventUri = "https://remote.example/events/boosted-existing";

    upsertRemoteEvent(db, eventObject(eventUri, "Original title", { to: [federation.AP_PUBLIC] }), existingOwnerUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: announcerUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/announce-existing",
        type: "Announce",
        actor: announcerUri,
        object: eventObject(eventUri, "Updated via announce", {
          attributedTo: differentAttributedUri,
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri: announcerUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 1, total: 1 });

    const row = db.prepare("SELECT actor_uri, title FROM remote_events WHERE uri = ?").get(eventUri) as {
      actor_uri: string;
      title: string;
    };
    expect(row).toEqual({ actor_uri: existingOwnerUri, title: "Updated via announce" });
  });

  it("skips pulled Event objects without a valid string id", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/create-no-id",
        type: "Create",
        actor: actorUri,
        object: {
          type: "Event",
          name: "No Id",
          startTime: "2026-06-01T10:00:00Z",
          attributedTo: actorUri,
          to: [federation.AP_PUBLIC],
        },
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events WHERE actor_uri = ?").get(actorUri) as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("does not fetch pulled object when id is non-string", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/create-non-string-id",
        type: "Create",
        actor: actorUri,
        object: {
          id: { value: "https://remote.example/events/non-string-id" },
          type: "Event",
          attributedTo: actorUri,
          to: [federation.AP_PUBLIC],
        },
      },
    ]);
    const fetchApSpy = vi.spyOn(federation, "fetchAP");

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });
    expect(fetchApSpy).not.toHaveBeenCalled();
  });

  it("rejects pulled Create when activity.actor mismatches outbox actor", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const outboxActorUri = insertRemoteActor(db);
    const otherActorUri = insertRemoteActor(db, "https://remote.example/users/carol");

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: outboxActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/create-mismatched-actor",
        type: "Create",
        actor: otherActorUri,
        object: eventObject("https://remote.example/events/mismatched-actor", "Should Be Ignored", {
          attributedTo: outboxActorUri,
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri: outboxActorUri }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_events WHERE uri = ?").get("https://remote.example/events/mismatched-actor") as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("rate-limits pulled actor mismatch logs during fetch-actor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-05-01T00:00:00.000Z"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const outboxActorUri = insertRemoteActor(db);
    const otherActorUri = insertRemoteActor(db, "https://remote.example/users/carol");

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: outboxActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/create-mismatched-actor-1",
        type: "Create",
        actor: otherActorUri,
        object: eventObject("https://remote.example/events/mismatched-actor-1", "Ignore", {
          attributedTo: outboxActorUri,
          to: [federation.AP_PUBLIC],
        }),
      },
      {
        id: "https://remote.example/activities/create-mismatched-actor-2",
        type: "Create",
        actor: otherActorUri,
        object: eventObject("https://remote.example/events/mismatched-actor-2", "Ignore Too", {
          attributedTo: outboxActorUri,
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));

    const first = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri: outboxActorUri }),
    });
    expect(first.status).toBe(200);

    const firstLogs = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("Rejected pulled Create: activity actor"));
    expect(firstLogs).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/create-mismatched-actor-3",
        type: "Create",
        actor: otherActorUri,
        object: eventObject("https://remote.example/events/mismatched-actor-3", "Ignore Again", {
          attributedTo: outboxActorUri,
          to: [federation.AP_PUBLIC],
        }),
      },
    ]);

    const second = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri: outboxActorUri }),
    });
    expect(second.status).toBe(200);

    const logs = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("Rejected pulled Create: activity actor"));
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("suppressed 1 similar logs in last 300s");
  });

  it("rejects pulled Delete when activity.actor is missing", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    const eventUri = "https://remote.example/events/delete-actor-missing";
    upsertRemoteEvent(db, eventObject(eventUri, "Keep Me", { to: [federation.AP_PUBLIC] }), actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      {
        id: "https://remote.example/activities/delete-actor-missing",
        type: "Delete",
        object: eventUri,
      },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });

    const row = db.prepare("SELECT canceled FROM remote_events WHERE uri = ?").get(eventUri) as { canceled: number };
    expect(row.canceled).toBe(0);
  });
});
