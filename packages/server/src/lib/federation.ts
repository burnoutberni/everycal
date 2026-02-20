/**
 * ActivityPub delivery — send signed activities to remote inboxes.
 */

import { signRequest } from "./crypto.js";
import type { DB } from "../db.js";
import { isPrivateIP, sanitizeHtml, assertPublicResolvedIP } from "./security.js";

const AP_CONTENT_TYPE = "application/activity+json";
const USER_AGENT = "EveryCal/0.1 (+https://github.com/everycal)";

/** Software types that support a Mastodon-compatible directory API */
const DIRECTORY_SUPPORTED = ["mastodon", "pleroma", "glitch", "hometown"];

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
  if (!forceRefresh) {
    const cached = db
      .prepare("SELECT * FROM remote_actors WHERE uri = ?")
      .get(actorUri) as RemoteActor | undefined;
    if (cached) return cached;
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
      last_fetched_at: new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO remote_actors (uri, type, preferred_username, display_name, summary,
        inbox, outbox, shared_inbox, followers_url, following_url, followers_count, following_count,
        icon_url, image_url, public_key_id, public_key_pem, domain, last_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uri) DO UPDATE SET
        type=excluded.type, preferred_username=excluded.preferred_username,
        display_name=excluded.display_name, summary=excluded.summary,
        inbox=excluded.inbox, outbox=excluded.outbox, shared_inbox=excluded.shared_inbox,
        followers_url=excluded.followers_url, following_url=excluded.following_url,
        followers_count=excluded.followers_count, following_count=excluded.following_count,
        icon_url=excluded.icon_url, image_url=excluded.image_url,
        public_key_id=excluded.public_key_id, public_key_pem=excluded.public_key_pem,
        domain=excluded.domain, last_fetched_at=excluded.last_fetched_at`
    ).run(
      actor.uri, actor.type, actor.preferred_username, actor.display_name, actor.summary,
      actor.inbox, actor.outbox, actor.shared_inbox, actor.followers_url, actor.following_url,
      actor.followers_count ?? null, actor.following_count ?? null,
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
  followers_count: number | null;
  following_count: number | null;
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
