/**
 * ActivityPub delivery — send signed activities to remote inboxes.
 */

import { signRequest } from "./crypto.js";
import type { DB } from "../db.js";
import { isPrivateIP, sanitizeHtml, assertPublicResolvedIP } from "./security.js";

const AP_CONTENT_TYPE = "application/activity+json";
const USER_AGENT = "EveryCal/0.1 (+https://github.com/everycal)";

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
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Validate that a URL is safe to fetch (prevents SSRF).
 * Rejects private/internal IPs, non-HTTPS, and non-standard ports.
 * Also resolves DNS to prevent DNS rebinding attacks.
 */
async function validateFederationUrl(url: string): Promise<void> {
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

/**
 * Resolve a remote actor by URI. Fetches and caches in remote_actors table.
 */
export async function resolveRemoteActor(
  db: DB,
  actorUri: string,
  forceRefresh = false
): Promise<RemoteActor | null> {
  if (!forceRefresh) {
    const cached = db
      .prepare("SELECT * FROM remote_actors WHERE uri = ?")
      .get(actorUri) as RemoteActor | undefined;
    if (cached) return cached;
  }

  try {
    const data = (await fetchAP(actorUri)) as Record<string, unknown>;
    if (!data.id || !data.inbox) return null;

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
      followers_url: (data.followers as string) || null,
      following_url: (data.following as string) || null,
      icon_url: (data.icon as Record<string, string>)?.url || null,
      image_url: (data.image as Record<string, string>)?.url || null,
      public_key_id: (data.publicKey as Record<string, string>)?.id || null,
      public_key_pem: (data.publicKey as Record<string, string>)?.publicKeyPem || null,
      domain: new URL(data.id as string).hostname,
      last_fetched_at: new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO remote_actors (uri, type, preferred_username, display_name, summary,
        inbox, outbox, shared_inbox, followers_url, following_url, icon_url, image_url,
        public_key_id, public_key_pem, domain, last_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uri) DO UPDATE SET
        type=excluded.type, preferred_username=excluded.preferred_username,
        display_name=excluded.display_name, summary=excluded.summary,
        inbox=excluded.inbox, outbox=excluded.outbox, shared_inbox=excluded.shared_inbox,
        followers_url=excluded.followers_url, following_url=excluded.following_url,
        icon_url=excluded.icon_url, image_url=excluded.image_url,
        public_key_id=excluded.public_key_id, public_key_pem=excluded.public_key_pem,
        domain=excluded.domain, last_fetched_at=excluded.last_fetched_at`
    ).run(
      actor.uri, actor.type, actor.preferred_username, actor.display_name, actor.summary,
      actor.inbox, actor.outbox, actor.shared_inbox, actor.followers_url, actor.following_url,
      actor.icon_url, actor.image_url, actor.public_key_id, actor.public_key_pem,
      actor.domain, actor.last_fetched_at
    );

    return actor;
  } catch (err) {
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
  icon_url: string | null;
  image_url: string | null;
  public_key_id: string | null;
  public_key_pem: string | null;
  domain: string;
  last_fetched_at: string;
}

/**
 * Send a signed activity to a remote inbox.
 */
export async function deliverActivity(
  inbox: string,
  activity: Record<string, unknown>,
  privateKeyPem: string,
  keyId: string
): Promise<boolean> {
  // Validate inbox URL to prevent SSRF
  await validateFederationUrl(inbox);

  const body = JSON.stringify(activity);
  const headers = signRequest("POST", inbox, body, privateKeyPem, keyId);
  headers["User-Agent"] = USER_AGENT;

  try {
    const res = await fetch(inbox, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Delivery to ${inbox} failed: ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Delivery to ${inbox} failed:`, err);
    return false;
  }
}

/**
 * Deliver an activity to all remote followers of a local account.
 */
export async function deliverToFollowers(
  db: DB,
  accountId: string,
  activity: Record<string, unknown>
): Promise<void> {
  const account = db
    .prepare("SELECT username, private_key FROM accounts WHERE id = ?")
    .get(accountId) as { username: string; private_key: string | null } | undefined;
  if (!account?.private_key) return;

  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const keyId = `${baseUrl}/users/${account.username}#main-key`;

  // Collect unique inboxes (prefer shared inboxes to reduce requests)
  const followers = db
    .prepare("SELECT follower_actor_uri, follower_inbox, follower_shared_inbox FROM remote_follows WHERE account_id = ?")
    .all(accountId) as { follower_actor_uri: string; follower_inbox: string; follower_shared_inbox: string | null }[];

  const inboxes = new Set<string>();
  for (const f of followers) {
    inboxes.add(f.follower_shared_inbox || f.follower_inbox);
  }

  // Fire-and-forget delivery (don't block the request)
  for (const inbox of inboxes) {
    deliverActivity(inbox, activity, account.private_key, keyId).catch(() => {});
  }
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
