import type { DeliveryResult, InboxVerificationResult, RemoteEventSummary, SyncResult } from "@everycal/runtime-core";
import type { CloudflareBindings } from "./storage";
import { CloudflareStorage } from "./storage";

type SignatureParts = {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
  hasRequiredHeaders: boolean;
};

const SIGNATURE_DATE_TOLERANCE_MS = 5 * 60 * 1000;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN[^-]+-----/g, "").replace(/-----END[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function parseSignatureHeader(value: string | null): SignatureParts | null {
  if (!value) return null;
  const map = new Map<string, string>();
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!key || !rawValue) continue;
    map.set(key, rawValue.replace(/^"|"$/g, ""));
  }
  const keyId = map.get("keyId");
  const algorithm = map.get("algorithm") || "";
  const signature = map.get("signature");
  const headers = (map.get("headers") || "(request-target) host date digest").split(/\s+/).filter(Boolean);
  const hasRequiredHeaders = ["(request-target)", "host", "date", "digest"].every((required) => headers.includes(required));
  if (!keyId || !signature || !algorithm) return null;
  return { keyId, algorithm, signature, headers, hasRequiredHeaders };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

function fromBase64(value: string): Uint8Array {
  const b = atob(value);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i += 1) out[i] = b.charCodeAt(i);
  return out;
}

async function sha256Base64(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return toBase64(new Uint8Array(digest));
}

function buildSigningString(headers: string[], request: Request, digestHeader: string): string {
  const url = new URL(request.url);
  const pathAndQuery = `${url.pathname}${url.search}`;
  return headers.map((h) => {
    const name = h.toLowerCase();
    if (name === "(request-target)") return `(request-target): ${request.method.toLowerCase()} ${pathAndQuery}`;
    if (name === "host") return `host: ${url.host}`;
    if (name === "digest") return `digest: ${digestHeader}`;
    return `${name}: ${request.headers.get(name) || ""}`;
  }).join("\n");
}

function isKeyIdOwnedByActor(keyId: string, actorUri: string): boolean {
  return keyId === actorUri || keyId.startsWith(`${actorUri}#`);
}

function isRecentDateHeader(value: string | null): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return Math.abs(Date.now() - parsed) <= SIGNATURE_DATE_TOLERANCE_MS;
}

async function resolveRemoteActorDocument(actorUri: string): Promise<Record<string, unknown> | null> {

  const res = await fetch(actorUri, {
    headers: {
      accept: "application/activity+json, application/ld+json",
      "user-agent": "everycal-worker/0.1",
    },
  });
  if (!res.ok) return null;
  return await res.json<Record<string, unknown>>();
}


function extractOutboxItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  const orderedItems = Array.isArray(payload.orderedItems) ? payload.orderedItems : [];
  return orderedItems.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
}

function extractNextPage(payload: Record<string, unknown>): string | null {
  const next = payload.next;
  return typeof next === "string" ? next : null;
}


function extractDeleteEventUri(activity: Record<string, unknown>): string | null {
  if (activity.type !== "Delete") return null;
  const object = activity.object;
  if (typeof object === "string") return object;
  if (object && typeof object === "object" && typeof (object as Record<string, unknown>).id === "string") {
    return (object as Record<string, unknown>).id as string;
  }
  return null;
}

async function pruneRemoteEventsForActor(env: CloudflareBindings, actorUri: string, activeUris: string[]): Promise<void> {
  if (activeUris.length === 0) {
    await env.DB.prepare("DELETE FROM remote_events WHERE actor_uri = ?1").bind(actorUri).run();
    return;
  }
  const placeholders = activeUris.map((_, i) => `?${i + 2}`).join(",");
  const query = `DELETE FROM remote_events WHERE actor_uri = ?1 AND uri NOT IN (${placeholders})`;
  await env.DB.prepare(query).bind(actorUri, ...activeUris).run();
}

async function removeRemoteEventsByUri(env: CloudflareBindings, actorUri: string, uris: Set<string>): Promise<void> {
  if (uris.size === 0) return;
  const values = [...uris];
  const placeholders = values.map((_, i) => `?${i + 2}`).join(",");
  const query = `DELETE FROM remote_events WHERE actor_uri = ?1 AND uri IN (${placeholders})`;
  await env.DB.prepare(query).bind(actorUri, ...values).run();
}

function actorToSummary(actorUri: string, doc: Record<string, unknown>) {
  const username = String(doc.preferredUsername || actorUri.split("/").pop() || "remote");
  const inbox = typeof doc.inbox === "string" ? doc.inbox : null;
  const icon = doc.icon as Record<string, unknown> | undefined;
  const iconUrl = icon && typeof icon.url === "string" ? icon.url : null;
  const host = new URL(actorUri).host;
  return {
    uri: actorUri,
    username,
    displayName: typeof doc.name === "string" ? doc.name : null,
    domain: host,
    inbox,
    iconUrl,
  };
}

export async function verifyInboxRequest(input: {
  request: Request;
  activity: { actor?: string };
}): Promise<InboxVerificationResult> {
  const actorUri = input.activity.actor;
  if (!actorUri) return { ok: false, status: 400, error: "missing_actor" };

  const signature = parseSignatureHeader(input.request.headers.get("signature"));
  if (!signature) return { ok: false, status: 401, error: "missing_signature" };
  if (signature.algorithm.toLowerCase() !== "rsa-sha256") return { ok: false, status: 401, error: "unsupported_signature_algorithm" };
  if (!signature.hasRequiredHeaders) return { ok: false, status: 401, error: "missing_required_signature_headers" };
  if (!isKeyIdOwnedByActor(signature.keyId, actorUri)) return { ok: false, status: 401, error: "key_mismatch" };

  if (!isRecentDateHeader(input.request.headers.get("date"))) {
    return { ok: false, status: 401, error: "stale_or_invalid_date" };
  }

  const digestHeader = input.request.headers.get("digest") || "";
  const body = await input.request.clone().text();
  const expected = `SHA-256=${await sha256Base64(body)}`;
  if (digestHeader !== expected) return { ok: false, status: 401, error: "invalid_digest" };

  const actorDoc = await resolveRemoteActorDocument(actorUri);
  const publicKeyRecord = actorDoc?.publicKey as Record<string, unknown> | undefined;
  const publicKey = publicKeyRecord?.publicKeyPem;
  const keyOwner = typeof publicKeyRecord?.owner === "string" ? publicKeyRecord.owner : null;
  const keyId = typeof publicKeyRecord?.id === "string" ? publicKeyRecord.id : null;
  if (!actorDoc || typeof publicKey !== "string") return { ok: false, status: 401, error: "missing_public_key" };
  if (keyOwner !== actorUri || keyId !== signature.keyId) {
    return { ok: false, status: 401, error: "untrusted_public_key" };
  }

  const verifyKey = await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(publicKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signingString = buildSigningString(signature.headers, input.request, digestHeader);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    verifyKey,
    fromBase64(signature.signature),
    new TextEncoder().encode(signingString)
  );

  return valid ? { ok: true } : { ok: false, status: 401, error: "invalid_signature" };
}

export async function deliverActivity(input: {
  env: CloudflareBindings;
  inbox: string;
  activity: Record<string, unknown>;
  actorKeyId: string;
}): Promise<DeliveryResult> {
  if (!input.env.ACTIVITYPUB_PRIVATE_KEY_PEM) {
    return { ok: false, status: 500, error: "missing_activitypub_private_key" };
  }

  const payload = JSON.stringify(input.activity);
  const date = new Date().toUTCString();
  const digest = `SHA-256=${await sha256Base64(payload)}`;
  const url = new URL(input.inbox);
  const signingString = [
    `(request-target): post ${url.pathname}${url.search}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(input.env.ACTIVITYPUB_PRIVATE_KEY_PEM),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingString));
  const signature = toBase64(new Uint8Array(sig));

  const signatureHeader = `keyId="${input.actorKeyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`;

  const res = await fetch(input.inbox, {
    method: "POST",
    headers: {
      "content-type": "application/activity+json",
      date,
      digest,
      signature: signatureHeader,
    },
    body: payload,
  });
  return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `delivery_failed_${res.status}` };
}

export async function syncRemoteActorAndEvents(input: {
  env: CloudflareBindings;
  actorUri: string;
}): Promise<SyncResult> {
  const storage = new CloudflareStorage(input.env);
  const actorDoc = await resolveRemoteActorDocument(input.actorUri);
  if (!actorDoc) return { actor: null, eventsSynced: 0 };

  const actor = actorToSummary(input.actorUri, actorDoc);
  if (!actor.inbox) return { actor: null, eventsSynced: 0 };
  await storage.upsertRemoteActor({ ...actor, inbox: actor.inbox });

  let eventsSynced = 0;
  const seenEventUris = new Set<string>();
  const deletedEventUris = new Set<string>();
  const outbox = typeof actorDoc.outbox === "string" ? actorDoc.outbox : null;
  let traversalComplete = true;

  if (outbox) {
    let nextUrl: string | null = outbox;
    const visited = new Set<string>();
    let pagesFetched = 0;

    while (nextUrl && pagesFetched < 5 && !visited.has(nextUrl)) {
      visited.add(nextUrl);
      pagesFetched += 1;
      const outboxRes = await fetch(nextUrl, { headers: { accept: "application/activity+json, application/ld+json" } });
      if (!outboxRes.ok) {
        traversalComplete = false;
        break;
      }

      const payload = await outboxRes.json<Record<string, unknown>>();
      const items = extractOutboxItems(payload);
      for (const activity of items) {
        const deleteUri = extractDeleteEventUri(activity);
        if (deleteUri) {
          deletedEventUris.add(deleteUri);
          continue;
        }

        const object = (activity.object && typeof activity.object === "object") ? activity.object as Record<string, unknown> : null;
        if (!object || object.type !== "Event" || typeof object.id !== "string") continue;
        const startDate = typeof object.startTime === "string" ? object.startTime : null;
        if (!startDate) continue;
        seenEventUris.add(object.id);
        const event: RemoteEventSummary = {
          uri: object.id,
          actorUri: input.actorUri,
          title: typeof object.name === "string" ? object.name : "Untitled",
          description: typeof object.content === "string" ? object.content : null,
          startDate,
          endDate: typeof object.endTime === "string" ? object.endTime : null,
        };
        await storage.upsertRemoteEvent(event);
        eventsSynced += 1;
      }

      nextUrl = extractNextPage(payload);
    }

    if (nextUrl && pagesFetched >= 5) traversalComplete = false;
  }

  await removeRemoteEventsByUri(input.env, input.actorUri, deletedEventUris);
  if (traversalComplete && outbox) {
    await pruneRemoteEventsForActor(input.env, input.actorUri, [...seenEventUris]);
  }

  return { actor: { ...actor, inbox: actor.inbox }, eventsSynced };
}
