/**
 * ActivityPub delivery — send signed activities to remote inboxes.
 */

import crypto from "node:crypto";
import type { EventVisibility } from "@everycal/core";
import { signRequest } from "./crypto.js";
import { buildActorUrl, getBaseUrl } from "./base-url.js";
import type { DB } from "../db.js";
import { isPrivateIP, sanitizeHtml, assertPublicResolvedIP } from "./security.js";

const AP_CONTENT_TYPE = "application/activity+json";
const USER_AGENT = "EveryCal/0.1 (+https://github.com/everycal)";
const DELETED_REMOTE_USERNAME = "deleted";
export const DELETED_REMOTE_DISPLAY_NAME = "Deleted account";

const FEDERATION_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

export const AP_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const EVENT_VISIBILITY_VALUES: ReadonlySet<EventVisibility> = new Set([
  "public",
  "unlisted",
  "followers_only",
  "private",
]);
const OUTBOUND_MAX_ATTEMPTS = 5;
const OUTBOUND_BASE_BACKOFF_MS = 60_000;
const OUTBOUND_PROCESS_LIMIT = 25;
const OUTBOUND_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const OUTBOUND_DELIVERY_TIMEOUT_MS = Math.max(1_000, Math.min(120_000, OUTBOUND_CLAIM_TIMEOUT_MS - 1_000));
const OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS_DEFAULT = 3600_000;
const OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS_MIN = 60_000;
const OUTBOUND_RETAIN_DELIVERED_DAYS_DEFAULT = 30;
const OUTBOUND_RETAIN_FAILED_DAYS_DEFAULT = 90;
const INBOX_PROCESSED_RETAIN_PROCESSED_DAYS_DEFAULT = 30;
const INBOX_PROCESSED_RETAIN_FAILED_DAYS_DEFAULT = 90;
const INBOX_PROCESSED_MAX_ROWS_DEFAULT = 0;
const INBOX_PROCESSED_CLEANUP_INTERVAL_MS_DEFAULT = 3600_000;
const INBOX_PROCESSED_CLEANUP_INTERVAL_MS_MIN = 60_000;
const outboundQueueRuns = new WeakMap<DB, Promise<{ processed: number; delivered: number; failed: number }>>();

function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function normalizeAudience(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function hasActivityPubAudience(value: unknown): boolean {
  return normalizeAudience(value).length > 0;
}

export type AttributedActorResult =
  | { status: "absent" }
  | { status: "parsed"; actor: string }
  | { status: "unparseable" };

function parseAttributedActorValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string") {
    return (value as Record<string, string>).id;
  }
  return null;
}

export function getAttributedActor(obj: Record<string, unknown>): AttributedActorResult {
  if (!("attributedTo" in obj)) return { status: "absent" };

  const raw = obj.attributedTo;
  if (raw == null) return { status: "absent" };

  const parsedSingle = parseAttributedActorValue(raw);
  if (parsedSingle) return { status: "parsed", actor: parsedSingle };

  if (Array.isArray(raw)) {
    for (const value of raw) {
      const parsed = parseAttributedActorValue(value);
      if (parsed) return { status: "parsed", actor: parsed };
    }
  }

  return { status: "unparseable" };
}

export function visibilityToActivityPubAddressing(
  visibility: EventVisibility | string | null | undefined,
  actorUri?: string,
): { to: string[]; cc: string[] } {
  const followers = actorUri ? `${actorUri}/followers` : undefined;
  const normalizedVisibility = normalizeEventVisibility(visibility);
  switch (normalizedVisibility) {
    case "unlisted":
      return { to: followers ? [followers] : [], cc: [AP_PUBLIC] };
    case "followers_only":
      return { to: followers ? [followers] : [], cc: [] };
    case "private":
      return { to: [], cc: [] };
    default:
      return { to: [AP_PUBLIC], cc: followers ? [followers] : [] };
  }
}

export function normalizeEventVisibility(
  visibility: EventVisibility | string | null | undefined,
  fallback: EventVisibility = "private",
): EventVisibility {
  if (typeof visibility === "string" && EVENT_VISIBILITY_VALUES.has(visibility as EventVisibility)) {
    return visibility as EventVisibility;
  }
  return fallback;
}

function normalizeAudienceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const normalizedPath = parsed.pathname.endsWith("/") && parsed.pathname !== "/"
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    return `${parsed.origin}${normalizedPath}${parsed.search}`;
  } catch {
    return null;
  }
}

export function deriveVisibilityFromActivityPubAddressing(
  source: Record<string, unknown>,
  options: { actorFollowersUrl?: string | null } = {},
): EventVisibility {
  const to = normalizeAudience(source.to);
  const cc = normalizeAudience(source.cc);
  const recipients = [...to, ...cc];
  if (to.includes(AP_PUBLIC)) return "public";
  if (cc.includes(AP_PUBLIC)) return "unlisted";
  const expectedFollowersUrl = options.actorFollowersUrl ? normalizeAudienceUrl(options.actorFollowersUrl) : null;
  if (expectedFollowersUrl && recipients.some((recipient) => normalizeAudienceUrl(recipient) === expectedFollowersUrl)) {
    return "followers_only";
  }
  if (recipients.length > 0) return "private";
  return "private";
}


/** Software types that support a Mastodon-compatible directory API */
const DIRECTORY_SUPPORTED = ["mastodon", "pleroma", "glitch", "hometown"];

export class FederationFetchError extends Error {
  status: number;
  statusText: string;
  url: string;

  constructor(url: string, status: number, statusText: string) {
    super(`Failed to fetch ${url}: ${status} ${statusText}`);
    this.name = "FederationFetchError";
    this.url = url;
    this.status = status;
    this.statusText = statusText;
  }
}

export interface RemoteActorAccount {
  username: string;
  displayName: string | null;
  domain: string;
  iconUrl: string | null;
}

export function formatRemoteActorAccount(input: {
  status?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  domain?: string | null;
  iconUrl?: string | null;
}): RemoteActorAccount | null {
  const domain = input.domain || "unknown";
  if (input.status === "gone") {
    return {
      username: `deleted@${domain}`,
      displayName: DELETED_REMOTE_DISPLAY_NAME,
      domain,
      iconUrl: null,
    };
  }

  if (!input.preferredUsername) return null;

  return {
    username: `${input.preferredUsername}@${domain}`,
    displayName: input.displayName || null,
    domain,
    iconUrl: input.iconUrl || null,
  };
}

export function formatRemoteActorIdentity(input: {
  status?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  summary?: string | null;
  iconUrl?: string | null;
  imageUrl?: string | null;
}): {
  username: string | null;
  displayName: string | null;
  summary: string | null;
  iconUrl: string | null;
  imageUrl: string | null;
} {
  if (input.status === "gone") {
    return {
      username: "deleted",
      displayName: DELETED_REMOTE_DISPLAY_NAME,
      summary: null,
      iconUrl: null,
      imageUrl: null,
    };
  }

  return {
    username: input.preferredUsername || null,
    displayName: input.displayName || null,
    summary: input.summary || null,
    iconUrl: input.iconUrl || null,
    imageUrl: input.imageUrl || null,
  };
}

export function parseRemoteActorUri(uri: string): { username: string; domain: string } {
  try {
    const parsed = new URL(uri);
    const domain = parsed.hostname;
    const segments = parsed.pathname.split("/").filter(Boolean);
    let username = segments.length > 0 ? segments[segments.length - 1] : "unknown";
    if (username.startsWith("@")) username = username.slice(1);
    if (!username) username = "unknown";
    return { username, domain };
  } catch {
    return { username: "unknown", domain: "unknown" };
  }
}

function parseActorUriFallback(actorUri: string): { username: string; domain: string } {
  const parsed = parseRemoteActorUri(actorUri);
  return {
    username: parsed.username === "unknown" ? DELETED_REMOTE_USERNAME : parsed.username,
    domain: parsed.domain,
  };
}

function upsertRemoteActorFetchState(
  db: DB,
  actorUri: string,
  state: {
    fetchStatus: "error" | "gone";
    lastError: string;
    nextRetryAt: string | null;
    goneAt: string | null;
    lastFetchedAt: string;
  }
): void {
  const parsed = parseActorUriFallback(actorUri);
  const placeholderDisplayName = state.fetchStatus === "gone" ? DELETED_REMOTE_DISPLAY_NAME : null;

  db.prepare(
    `INSERT INTO remote_actors (
       uri, type, preferred_username, display_name, summary,
       inbox, outbox, shared_inbox, followers_url, following_url,
       icon_url, image_url, public_key_id, public_key_pem, domain,
       last_fetched_at, fetch_status, last_error, next_retry_at, gone_at
     )
     VALUES (?, 'Person', ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       display_name = CASE WHEN excluded.fetch_status = 'gone' THEN excluded.display_name ELSE remote_actors.display_name END,
       fetch_status = excluded.fetch_status,
       last_error = excluded.last_error,
       next_retry_at = excluded.next_retry_at,
       gone_at = excluded.gone_at,
       last_fetched_at = excluded.last_fetched_at`
  ).run(
    actorUri,
    parsed.username,
    placeholderDisplayName,
    actorUri,
    parsed.domain,
    state.lastFetchedAt,
    state.fetchStatus,
    state.lastError,
    state.nextRetryAt,
    state.goneAt
  );
}

/**
 * Fetch a remote ActivityPub object/actor with proper Accept header.
 * Validates the URL to prevent SSRF attacks against internal networks.
 */
export async function fetchAP(url: string): Promise<unknown> {
  await validateFederationUrl(url);

  const res = await fetch(url, {
    headers: {
      Accept: `${AP_CONTENT_TYPE}, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`,
      "User-Agent": USER_AGENT,
    },
    redirect: "error", // Don't follow redirects (prevents redirect-based SSRF)
  });
  if (!res.ok) {
    throw new FederationFetchError(url, res.status, res.statusText);
  }
  return res.json();
}

/**
 * Validate that a URL is safe to fetch (prevents SSRF).
 * Rejects private/internal IPs, non-HTTPS, and non-standard ports.
 * Also resolves DNS to prevent DNS rebinding attacks.
 */
export async function validateFederationUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Only allow HTTPS in production
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error(`Only HTTPS URLs are allowed: ${url}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid protocol: ${parsed.protocol}`);
  }

  // Block private/internal IP ranges
  const hostname = parsed.hostname;
  if (isPrivateIP(hostname)) {
    throw new Error(`Requests to private/internal addresses are not allowed: ${hostname}`);
  }

  // DNS rebinding protection: resolve hostname and check the actual IP
  await assertPublicResolvedIP(hostname);
}

/** Extract totalItems from an ActivityPub collection (URL or inline object). */
async function fetchCollectionCount(
  ref: string | Record<string, unknown> | undefined
): Promise<number | null> {
  if (!ref) return null;
  if (typeof ref === "object" && typeof ref.totalItems === "number") {
    return ref.totalItems >= 0 ? ref.totalItems : null;
  }
  const url = typeof ref === "string" ? ref : (ref as Record<string, string>)?.id;
  if (!url) return null;
  try {
    const coll = (await fetchAP(url)) as Record<string, unknown>;
    const n = coll?.totalItems;
    return typeof n === "number" && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a remote actor by URI. Fetches and caches in remote_actors table.
 * Also fetches follower/following counts from collection URLs for up-to-date stats.
 */
export async function resolveRemoteActor(
  db: DB,
  actorUri: string,
  forceRefresh = false
): Promise<RemoteActor | null> {
  const nowIso = new Date().toISOString();

  if (!forceRefresh) {
    const cached = db
      .prepare("SELECT * FROM remote_actors WHERE uri = ?")
      .get(actorUri) as RemoteActor | undefined;
    if (cached?.fetch_status === "gone") return null;
    if (cached?.fetch_status === "error") {
      const hasUsableCachedActor =
        !!cached.public_key_pem ||
        !!cached.outbox ||
        (typeof cached.inbox === "string" && cached.inbox.length > 0 && cached.inbox !== cached.uri);
      if (hasUsableCachedActor) return cached;
      if (cached.next_retry_at && cached.next_retry_at > nowIso) return null;
    } else if (cached) {
      return cached;
    }
  }

  try {
    const data = (await fetchAP(actorUri)) as Record<string, unknown>;
    if (!data.id || !data.inbox) return null;

    const followersRef = data.followers;
    const followingRef = data.following;
    const followersUrl =
      typeof followersRef === "string"
        ? followersRef
        : (followersRef as Record<string, string>)?.id || null;
    const followingUrl =
      typeof followingRef === "string"
        ? followingRef
        : (followingRef as Record<string, string>)?.id || null;

    const [followersCount, followingCount] = await Promise.all([
      fetchCollectionCount(followersRef as string | Record<string, unknown> | undefined),
      fetchCollectionCount(followingRef as string | Record<string, unknown> | undefined),
    ]);

    const actor: RemoteActor = {
      uri: data.id as string,
      type: (data.type as string) || "Person",
      preferred_username: (data.preferredUsername as string) || "",
      display_name: (data.name as string) || (data.preferredUsername as string) || "",
      summary: typeof data.summary === "string" ? sanitizeHtml(data.summary) : null,
      inbox: data.inbox as string,
      outbox: (data.outbox as string) || null,
      shared_inbox:
        (data.endpoints as Record<string, string>)?.sharedInbox || null,
      followers_url: followersUrl,
      following_url: followingUrl,
      followers_count: followersCount,
      following_count: followingCount,
      icon_url: (data.icon as Record<string, string>)?.url || null,
      image_url: (data.image as Record<string, string>)?.url || null,
      public_key_id: (data.publicKey as Record<string, string>)?.id || null,
      public_key_pem: (data.publicKey as Record<string, string>)?.publicKeyPem || null,
      domain: new URL(data.id as string).hostname,
      last_fetched_at: nowIso,
      fetch_status: "active",
      last_error: null,
      next_retry_at: null,
      gone_at: null,
    };

    db.prepare(
      `INSERT INTO remote_actors (uri, type, preferred_username, display_name, summary,
        inbox, outbox, shared_inbox, followers_url, following_url, followers_count, following_count,
        icon_url, image_url, public_key_id, public_key_pem, domain, last_fetched_at,
        fetch_status, last_error, next_retry_at, gone_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uri) DO UPDATE SET
         type=excluded.type, preferred_username=excluded.preferred_username,
         display_name=excluded.display_name, summary=excluded.summary,
         inbox=excluded.inbox, outbox=excluded.outbox, shared_inbox=excluded.shared_inbox,
         followers_url=excluded.followers_url, following_url=excluded.following_url,
         followers_count=excluded.followers_count, following_count=excluded.following_count,
         icon_url=excluded.icon_url, image_url=excluded.image_url,
         public_key_id=excluded.public_key_id, public_key_pem=excluded.public_key_pem,
         domain=excluded.domain, last_fetched_at=excluded.last_fetched_at,
         fetch_status=excluded.fetch_status, last_error=excluded.last_error,
         next_retry_at=excluded.next_retry_at, gone_at=excluded.gone_at`
    ).run(
      actor.uri, actor.type, actor.preferred_username, actor.display_name, actor.summary,
      actor.inbox, actor.outbox, actor.shared_inbox, actor.followers_url, actor.following_url,
      actor.followers_count ?? null, actor.following_count ?? null,
      actor.icon_url, actor.image_url, actor.public_key_id, actor.public_key_pem,
      actor.domain, actor.last_fetched_at,
      actor.fetch_status, actor.last_error, actor.next_retry_at, actor.gone_at
    );

    return actor;
  } catch (err) {
    if (err instanceof FederationFetchError && err.status === 410) {
      upsertRemoteActorFetchState(db, actorUri, {
        fetchStatus: "gone",
        lastError: err.message,
        nextRetryAt: null,
        goneAt: nowIso,
        lastFetchedAt: nowIso,
      });

      db.prepare("DELETE FROM remote_following WHERE actor_uri = ?").run(actorUri);
      db.prepare("DELETE FROM remote_follows WHERE follower_actor_uri = ?").run(actorUri);
      return null;
    }

    const retryAtIso = new Date(Date.now() + FEDERATION_RETRY_DELAY_MS).toISOString();
    const message = err instanceof Error ? err.message : String(err);
    upsertRemoteActorFetchState(db, actorUri, {
      fetchStatus: "error",
      lastError: message,
      nextRetryAt: retryAtIso,
      goneAt: null,
      lastFetchedAt: nowIso,
    });
    console.error(`Failed to resolve actor ${actorUri}:`, err);
    return null;
  }
}

export interface RemoteActor {
  uri: string;
  type: string;
  preferred_username: string;
  display_name: string;
  summary: string | null;
  inbox: string;
  outbox: string | null;
  shared_inbox: string | null;
  followers_url: string | null;
  following_url: string | null;
  followers_count: number | null;
  following_count: number | null;
  icon_url: string | null;
  image_url: string | null;
  public_key_id: string | null;
  public_key_pem: string | null;
  domain: string;
  last_fetched_at: string;
  fetch_status?: "active" | "error" | "gone";
  last_error?: string | null;
  next_retry_at?: string | null;
  gone_at?: string | null;
}

/**
 * Send a signed activity to a remote inbox.
 */
async function deliverActivityWithResult(
  inbox: string,
  activity: Record<string, unknown>,
  privateKeyPem: string,
  keyId: string
): Promise<{ ok: boolean; error: string | null }> {
  // Validate inbox URL to prevent SSRF
  await validateFederationUrl(inbox);

  const body = JSON.stringify(activity);
  const headers = signRequest("POST", inbox, body, privateKeyPem, keyId);
  headers["User-Agent"] = USER_AGENT;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), OUTBOUND_DELIVERY_TIMEOUT_MS);

  try {
    const res = await fetch(inbox, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = `Delivery to ${inbox} failed: ${res.status} ${text.slice(0, 200)}`;
      return { ok: false, error: message };
    }
    return { ok: true, error: null };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `Delivery to ${inbox} timed out after ${OUTBOUND_DELIVERY_TIMEOUT_MS}ms` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Delivery to ${inbox} failed: ${message}` };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function deliverActivity(
  inbox: string,
  activity: Record<string, unknown>,
  privateKeyPem: string,
  keyId: string
): Promise<boolean> {
  const result = await deliverActivityWithResult(inbox, activity, privateKeyPem, keyId);
  if (!result.ok && result.error) {
    console.error(result.error);
  }
  return result.ok;
}

/**
 * Deliver an activity to all remote followers of a local account.
 */
export function enqueueOutboundDelivery(
  db: DB,
  params: { destinationInbox: string; senderAccountId: string; senderActorUri: string; activity: Record<string, unknown> },
): string {
  const id = crypto.randomUUID();
  const senderKeyId = `${params.senderActorUri}#main-key`;
  db.prepare(
    `INSERT INTO outbound_activity_deliveries
      (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, next_retry_at, state)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'pending')`,
  ).run(id, params.destinationInbox, params.senderAccountId, params.senderActorUri, senderKeyId, JSON.stringify(params.activity));
  return id;
}

function nextBackoffMs(attemptCount: number): number {
  return OUTBOUND_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attemptCount - 1));
}

function parseEnvNumber(rawValue: string | undefined, fallback: number): number {
  if (rawValue === undefined) return fallback;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRetentionDays(rawValue: string | undefined, fallback: number): number {
  return Math.max(0, Math.floor(parseEnvNumber(rawValue, fallback)));
}

function parseCleanupIntervalMs(rawValue: string | undefined): number {
  return Math.max(OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS_MIN, parseEnvNumber(rawValue, OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS_DEFAULT));
}

function parseMaxRows(rawValue: string | undefined, fallback: number): number {
  return Math.max(0, Math.floor(parseEnvNumber(rawValue, fallback)));
}

export async function processOutboundDeliveryQueue(db: DB, limit = OUTBOUND_PROCESS_LIMIT): Promise<{ processed: number; delivered: number; failed: number }> {
  const existingRun = outboundQueueRuns.get(db);
  if (existingRun) return existingRun;

  const run = (async () => {
    const workerId = crypto.randomUUID();
    const staleClaimBefore = toSqliteDateTime(new Date(Date.now() - OUTBOUND_CLAIM_TIMEOUT_MS));
    const claimJobs = db.transaction((batchLimit: number, currentWorkerId: string, staleClaimCutoff: string) => {
      db.prepare(
        `UPDATE outbound_activity_deliveries
         SET state = 'pending', claimed_at = NULL, worker_id = NULL, updated_at = datetime('now')
         WHERE state = 'processing' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
      ).run(staleClaimCutoff);

       db.prepare(
         `UPDATE outbound_activity_deliveries
          SET state = 'processing', claimed_at = datetime('now'), worker_id = ?, updated_at = datetime('now')
          WHERE id IN (
            SELECT id
            FROM outbound_activity_deliveries
            WHERE state = 'pending' AND worker_id IS NULL AND next_retry_at <= datetime('now')
            ORDER BY next_retry_at, created_at
            LIMIT ?
          )
            AND state = 'pending'
            AND worker_id IS NULL`,
       ).run(currentWorkerId, batchLimit);

       return db.prepare(
         `SELECT d.*, a.private_key
          FROM outbound_activity_deliveries d
          JOIN accounts a ON a.id = d.sender_account_id
          WHERE d.state = 'processing' AND d.worker_id = ?
          ORDER BY d.claimed_at, d.created_at`,
       ).all(currentWorkerId) as Array<{
         id: string; destination_inbox: string; sender_account_id: string; sender_actor_uri: string; activity_json: string;
         sender_key_id: string | null; attempt_count: number; private_key: string | null;
       }>;
    });

    const jobs = claimJobs(limit, workerId, staleClaimBefore) as Array<{
      id: string; destination_inbox: string; sender_account_id: string; sender_actor_uri: string; activity_json: string;
      sender_key_id: string | null; attempt_count: number; private_key: string | null;
    }>;
    let delivered = 0;
    let failed = 0;
    for (const job of jobs) {
      if (!job.private_key) {
        db.prepare("UPDATE outbound_activity_deliveries SET state = 'failed', claimed_at = NULL, worker_id = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ? AND state = 'processing' AND worker_id = ?")
          .run("sender account has no private key", job.id, workerId);
        failed++;
        continue;
      }
      let activity: Record<string, unknown>;
      try {
        activity = JSON.parse(job.activity_json) as Record<string, unknown>;
      } catch {
        db.prepare("UPDATE outbound_activity_deliveries SET state = 'failed', claimed_at = NULL, worker_id = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ? AND state = 'processing' AND worker_id = ?")
          .run("invalid stored activity JSON", job.id, workerId);
        failed++;
        continue;
      }
      const keyId = job.sender_key_id || `${job.sender_actor_uri}#main-key`;
      let ok = false;
      let deliveryError: string | null = null;
      try {
        const result = await deliverActivityWithResult(job.destination_inbox, activity, job.private_key, keyId);
        ok = result.ok;
        deliveryError = result.error;
        if (!ok && deliveryError) {
          console.error(`[Federation] outbound delivery ${job.id} failed: ${deliveryError}`);
        }
      } catch (err) {
        deliveryError = err instanceof Error ? err.message : String(err);
        console.error(`[Federation] outbound delivery ${job.id} threw`, err);
      }
      const attempts = job.attempt_count + 1;
      if (ok) {
        db.prepare("UPDATE outbound_activity_deliveries SET state = 'delivered', attempt_count = ?, claimed_at = NULL, worker_id = NULL, last_error = NULL, updated_at = datetime('now') WHERE id = ? AND state = 'processing' AND worker_id = ?")
          .run(attempts, job.id, workerId);
        delivered++;
      } else if (attempts >= OUTBOUND_MAX_ATTEMPTS) {
        db.prepare("UPDATE outbound_activity_deliveries SET state = 'failed', attempt_count = ?, claimed_at = NULL, worker_id = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ? AND state = 'processing' AND worker_id = ?")
          .run(attempts, deliveryError || `delivery failed after ${attempts} attempts`, job.id, workerId);
        failed++;
        console.error(`[Federation] outbound delivery ${job.id} failed permanently after ${attempts} attempts`);
      } else {
        const retryAt = toSqliteDateTime(new Date(Date.now() + nextBackoffMs(attempts)));
        db.prepare("UPDATE outbound_activity_deliveries SET state = 'pending', attempt_count = ?, next_retry_at = ?, claimed_at = NULL, worker_id = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ? AND state = 'processing' AND worker_id = ?")
          .run(attempts, retryAt, deliveryError || `delivery attempt ${attempts} failed`, job.id, workerId);
      }
    }
    return { processed: jobs.length, delivered, failed };
  })();

  outboundQueueRuns.set(db, run);
  try {
    return await run;
  } finally {
    if (outboundQueueRuns.get(db) === run) outboundQueueRuns.delete(db);
  }
}

export function startOutboundDeliveryWorker(db: DB): NodeJS.Timeout | null {
  const rawInterval = process.env.OUTBOUND_DELIVERY_INTERVAL_MS;
  const intervalMs = Math.max(1000, parseEnvNumber(rawInterval, 30000));
  const run = () => {
    processOutboundDeliveryQueue(db).catch((err) => console.error("[Federation] outbound delivery worker failed", err));
  };
  run();
  return setInterval(run, intervalMs);
}

export function cleanupTerminalOutboundDeliveries(
  db: DB,
  options: { deliveredRetentionDays?: number; failedRetentionDays?: number } = {}
): { deletedDelivered: number; deletedFailed: number } {
  const deliveredRetentionDays = Math.max(0, Math.floor(options.deliveredRetentionDays ?? OUTBOUND_RETAIN_DELIVERED_DAYS_DEFAULT));
  const failedRetentionDays = Math.max(0, Math.floor(options.failedRetentionDays ?? OUTBOUND_RETAIN_FAILED_DAYS_DEFAULT));
  const cleanup = db.transaction((deliveredDays: number, failedDays: number) => {
    const deletedDelivered = db
      .prepare("DELETE FROM outbound_activity_deliveries WHERE state = 'delivered' AND updated_at < datetime('now', '-' || ? || ' days')")
      .run(deliveredDays).changes;
    const deletedFailed = db
      .prepare("DELETE FROM outbound_activity_deliveries WHERE state = 'failed' AND updated_at < datetime('now', '-' || ? || ' days')")
      .run(failedDays).changes;
    return { deletedDelivered, deletedFailed };
  });
  return cleanup(deliveredRetentionDays, failedRetentionDays) as { deletedDelivered: number; deletedFailed: number };
}

export function startOutboundTerminalCleanupWorker(db: DB): NodeJS.Timeout | null {
  const deliveredRetentionDays = parseRetentionDays(
    process.env.OUTBOUND_RETAIN_DELIVERED_DAYS,
    OUTBOUND_RETAIN_DELIVERED_DAYS_DEFAULT
  );
  const failedRetentionDays = parseRetentionDays(process.env.OUTBOUND_RETAIN_FAILED_DAYS, OUTBOUND_RETAIN_FAILED_DAYS_DEFAULT);
  const intervalMs = parseCleanupIntervalMs(process.env.OUTBOUND_TERMINAL_CLEANUP_INTERVAL_MS);

  const run = () => {
    try {
      const result = cleanupTerminalOutboundDeliveries(db, { deliveredRetentionDays, failedRetentionDays });
      if (result.deletedDelivered > 0 || result.deletedFailed > 0) {
        console.log(
          `[Federation] cleaned terminal outbound rows: delivered=${result.deletedDelivered}, failed=${result.deletedFailed}`
        );
      }
    } catch (err) {
      console.error("[Federation] outbound terminal cleanup failed", err);
    }
  };

  run();
  return setInterval(run, intervalMs);
}

export function cleanupProcessedInboxActivities(
  db: DB,
  options: {
    processedRetentionDays?: number;
    failedRetentionDays?: number;
    maxRows?: number;
  } = {}
): { deletedProcessed: number; deletedFailed: number; deletedCapped: number } {
  const processedRetentionDays = Math.max(0, Math.floor(options.processedRetentionDays ?? INBOX_PROCESSED_RETAIN_PROCESSED_DAYS_DEFAULT));
  const failedRetentionDays = Math.max(0, Math.floor(options.failedRetentionDays ?? INBOX_PROCESSED_RETAIN_FAILED_DAYS_DEFAULT));
  const maxRows = Math.max(0, Math.floor(options.maxRows ?? INBOX_PROCESSED_MAX_ROWS_DEFAULT));

  const cleanup = db.transaction((processedDays: number, failedDays: number, keepRows: number) => {
    const deletedProcessed = db
      .prepare(
        "DELETE FROM processed_inbox_activities WHERE status = 'processed' AND received_at < datetime('now', '-' || ? || ' days')"
      )
      .run(processedDays).changes;

    const deletedFailed = db
      .prepare(
        "DELETE FROM processed_inbox_activities WHERE status = 'failed' AND received_at < datetime('now', '-' || ? || ' days')"
      )
      .run(failedDays).changes;

    let deletedCapped = 0;
    if (keepRows > 0) {
      deletedCapped = db
        .prepare(
          `DELETE FROM processed_inbox_activities
           WHERE rowid IN (
             SELECT rowid
             FROM processed_inbox_activities
             WHERE status IN ('processed', 'failed')
             ORDER BY datetime(received_at) DESC, rowid DESC
             LIMIT -1 OFFSET ?
           )`
        )
        .run(keepRows).changes;
    }

    return { deletedProcessed, deletedFailed, deletedCapped };
  });

  return cleanup(processedRetentionDays, failedRetentionDays, maxRows) as {
    deletedProcessed: number;
    deletedFailed: number;
    deletedCapped: number;
  };
}

export function startProcessedInboxCleanupWorker(db: DB): NodeJS.Timeout | null {
  const processedRetentionDays = parseRetentionDays(
    process.env.INBOX_PROCESSED_RETAIN_DAYS,
    INBOX_PROCESSED_RETAIN_PROCESSED_DAYS_DEFAULT,
  );
  const failedRetentionDays = parseRetentionDays(
    process.env.INBOX_FAILED_RETAIN_DAYS,
    INBOX_PROCESSED_RETAIN_FAILED_DAYS_DEFAULT,
  );
  const maxRows = parseMaxRows(process.env.INBOX_PROCESSED_MAX_ROWS, INBOX_PROCESSED_MAX_ROWS_DEFAULT);
  const intervalMs = Math.max(
    INBOX_PROCESSED_CLEANUP_INTERVAL_MS_MIN,
    parseEnvNumber(process.env.INBOX_PROCESSED_CLEANUP_INTERVAL_MS, INBOX_PROCESSED_CLEANUP_INTERVAL_MS_DEFAULT),
  );

  const run = () => {
    try {
      const result = cleanupProcessedInboxActivities(db, {
        processedRetentionDays,
        failedRetentionDays,
        maxRows,
      });
      if (result.deletedProcessed > 0 || result.deletedFailed > 0 || result.deletedCapped > 0) {
        console.log(
          `[Federation] cleaned processed inbox rows: processed=${result.deletedProcessed}, failed=${result.deletedFailed}, capped=${result.deletedCapped}`
        );
      }
    } catch (err) {
      console.error("[Federation] processed inbox cleanup failed", err);
    }
  };

  run();
  return setInterval(run, intervalMs);
}

export async function deliverToFollowers(
  db: DB,
  accountId: string,
  activity: Record<string, unknown>
): Promise<void> {
  const account = db
    .prepare("SELECT username, private_key FROM accounts WHERE id = ?")
    .get(accountId) as { username: string; private_key: string | null } | undefined;
  if (!account?.private_key) return;

  const baseUrl = getBaseUrl();
  const actorUri = buildActorUrl(account.username, baseUrl);

  const followers = db
    .prepare("SELECT follower_actor_uri, follower_inbox, follower_shared_inbox FROM remote_follows WHERE account_id = ?")
    .all(accountId) as { follower_actor_uri: string; follower_inbox: string; follower_shared_inbox: string | null }[];

  const inboxes = new Set<string>();
  for (const f of followers) inboxes.add(f.follower_shared_inbox || f.follower_inbox);

  if (inboxes.size === 0) return;

  for (const inbox of inboxes) enqueueOutboundDelivery(db, { destinationInbox: inbox, senderAccountId: accountId, senderActorUri: actorUri, activity });
  processOutboundDeliveryQueue(db, Math.min(inboxes.size, OUTBOUND_PROCESS_LIMIT)).catch(() => {});
}

/**
 * Fetch NodeInfo to detect remote server software type.
 */
export async function fetchNodeInfo(domain: string): Promise<{ software: string } | null> {
  const base = `https://${domain}`;
  await validateFederationUrl(base);

  try {
    const res = await fetch(`${base}/.well-known/nodeinfo`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as { links?: Array<{ rel: string; href: string }> };
    const href = doc.links?.find(
      (l) =>
        l.rel === "http://nodeinfo.diaspora.software/ns/schema/2.1" ||
        l.rel === "http://nodeinfo.diaspora.software/ns/schema/2.0"
    )?.href;
    if (!href) return null;

    const nodeRes = await fetch(href, { headers: { Accept: "application/json" } });
    if (!nodeRes.ok) return null;
    const node = (await nodeRes.json()) as { software?: { name?: string } };
    const name = node.software?.name?.toLowerCase();
    return name ? { software: name } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch actor URIs from a Mastodon-compatible directory API.
 */
async function fetchMastodonDirectory(domain: string, maxAccounts = 500): Promise<string[]> {
  const base = `https://${domain}`;
  const uris: string[] = [];
  let offset = 0;
  const limit = 80;

  while (uris.length < maxAccounts) {
    const url = `${base}/api/v1/directory?limit=${limit}&offset=${offset}&order=active&local=true`;
    await validateFederationUrl(url);

    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!res.ok) break;

    const accounts = (await res.json()) as Array<{
      uri?: string;
      url?: string;
      acct?: string;
      username?: string;
    }>;
    if (accounts.length === 0) break;

    for (const a of accounts) {
      if (a.uri) {
        uris.push(a.uri);
      } else {
        const acct = a.acct?.includes("@") ? a.acct : `${a.username || a.acct}@${domain}`;
        const actorUri = await webfingerToActorUri(domain, acct);
        if (actorUri) uris.push(actorUri);
      }
    }
    offset += accounts.length;
    if (accounts.length < limit) break;
  }

  return uris;
}

async function webfingerToActorUri(domain: string, acct: string): Promise<string | null> {
  const [user, host] = acct.includes("@") ? acct.split("@") : [acct, domain];
  if (!user || !host) return null;
  const wfUrl = `https://${host}/.well-known/webfinger?resource=acct:${user}@${host}`;
  await validateFederationUrl(wfUrl);

  try {
    const res = await fetch(wfUrl, { headers: { Accept: "application/jrd+json" } });
    if (!res.ok) return null;
    const wf = (await res.json()) as {
      links?: Array<{ rel: string; type?: string; href?: string }>;
    };
    const self = wf.links?.find(
      (l) => l.rel === "self" && l.type === "application/activity+json"
    );
    return self?.href || null;
  } catch {
    return null;
  }
}

/**
 * Discover and cache all profiles from a remote server when it supports a directory API.
 * Updates domain_discovery table. Call when we first connect to a domain or to refresh.
 */
export async function discoverDomainActors(
  db: DB,
  domain: string,
  options?: { maxAccounts?: number; minAgeHours?: number }
): Promise<{ discovered: number; software: string | null }> {
  if (isPrivateIP(domain)) return { discovered: 0, software: null };

  const minAgeHours = options?.minAgeHours ?? 24;
  const existing = db
    .prepare("SELECT last_discovered_at FROM domain_discovery WHERE domain = ?")
    .get(domain) as { last_discovered_at: string } | undefined;

  if (existing) {
    const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString();
    if (existing.last_discovered_at >= cutoff) {
      return { discovered: 0, software: null };
    }
  }

  const nodeInfo = await fetchNodeInfo(domain);
  const software = nodeInfo?.software ?? null;

  if (!software || !DIRECTORY_SUPPORTED.includes(software)) {
    db.prepare(
      `INSERT INTO domain_discovery (domain, last_discovered_at, software_type)
       VALUES (?, datetime('now'), ?)
       ON CONFLICT(domain) DO UPDATE SET last_discovered_at = datetime('now'), software_type = excluded.software_type`
    ).run(domain, software);
    return { discovered: 0, software };
  }

  const maxAccounts = options?.maxAccounts ?? 300;
  let uris: string[];
  try {
    uris = await fetchMastodonDirectory(domain, maxAccounts);
  } catch (err) {
    console.warn(`Domain discovery failed for ${domain}:`, err);
    return { discovered: 0, software };
  }

  let discovered = 0;
  const concurrency = 5;
  for (let i = 0; i < uris.length; i += concurrency) {
    const batch = uris.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((uri) => resolveRemoteActor(db, uri, true))
    );
    discovered += results.filter(Boolean).length;
  }

  db.prepare(
    `INSERT INTO domain_discovery (domain, last_discovered_at, software_type)
     VALUES (?, datetime('now'), ?)
     ON CONFLICT(domain) DO UPDATE SET last_discovered_at = datetime('now'), software_type = excluded.software_type`
  ).run(domain, software);

  return { discovered, software };
}

/**
 * Fetch items from a remote ActivityPub collection (followers, following, etc.).
 * Handles OrderedCollection with first/page structure and pagination.
 */
export async function fetchRemoteCollection(
  collectionUrl: string,
  maxPages = 5
): Promise<string[]> {
  const coll = (await fetchAP(collectionUrl)) as Record<string, unknown>;

  let items: unknown[] = [];
  let nextUrl: string | null = null;

  if (coll.first && typeof coll.first === "object") {
    const page = coll.first as Record<string, unknown>;
    items = (page.orderedItems as unknown[]) || (page.items as unknown[]) || [];
    nextUrl = (page.next as string) || null;
  } else if (coll.first && typeof coll.first === "string") {
    const page = (await fetchAP(coll.first)) as Record<string, unknown>;
    items = (page.orderedItems as unknown[]) || (page.items as unknown[]) || [];
    nextUrl = (page.next as string) || null;
  } else if (coll.orderedItems || coll.items) {
    items = (coll.orderedItems as unknown[]) || (coll.items as unknown[]) || [];
  }

  let pagesFetched = 1;
  while (nextUrl && pagesFetched < maxPages) {
    try {
      const page = (await fetchAP(nextUrl)) as Record<string, unknown>;
      const pageItems = (page.orderedItems as unknown[]) || (page.items as unknown[]) || [];
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      nextUrl = (page.next as string) || null;
      pagesFetched++;
    } catch {
      break;
    }
  }

  return items.map((item) => {
    if (typeof item === "string") return item;
    const obj = item as Record<string, unknown>;
    return (obj.id as string) || "";
  }).filter(Boolean);
}

/**
 * Fetch events from a remote actor's outbox, following pagination.
 */
export async function fetchRemoteOutbox(outboxUrl: string, maxPages = 10): Promise<unknown[]> {
  const outbox = (await fetchAP(outboxUrl)) as Record<string, unknown>;

  let items: unknown[] = [];
  let nextUrl: string | null = null;

  // OrderedCollection with inline first page
  if (outbox.first && typeof outbox.first === "object") {
    const page = outbox.first as Record<string, unknown>;
    items = (page.orderedItems as unknown[]) || [];
    nextUrl = (page.next as string) || null;
  }
  // OrderedCollection with first as URL
  else if (outbox.first && typeof outbox.first === "string") {
    const page = (await fetchAP(outbox.first)) as Record<string, unknown>;
    items = (page.orderedItems as unknown[]) || [];
    nextUrl = (page.next as string) || null;
  }
  // Inline orderedItems (no pagination)
  else if (outbox.orderedItems) {
    items = outbox.orderedItems as unknown[];
  }

  // Follow pagination
  let pagesFetched = 1;
  while (nextUrl && pagesFetched < maxPages) {
    try {
      const page = (await fetchAP(nextUrl)) as Record<string, unknown>;
      const pageItems = (page.orderedItems as unknown[]) || [];
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      nextUrl = (page.next as string) || null;
      pagesFetched++;
    } catch {
      break;
    }
  }

  return items;
}
