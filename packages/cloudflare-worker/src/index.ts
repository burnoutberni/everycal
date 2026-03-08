import { createUnifiedApp } from "../../runtime-core/src/index";
import { CloudflareStorage, type CloudflareBindings } from "./storage";
import { hashPassword, verifyPassword } from "./security";
import { renderWorkerHtml } from "./ssr";
import { deliverActivity, syncRemoteActorAndEvents, verifyInboxRequest } from "./federation";

type QueueMessageBody = {
  type?: string;
  attempts?: number;
  enqueuedAt?: string;
  jobId?: string;
};

type DeployReadinessCheck = {
  id: string;
  ok: boolean;
  detail: string;
  level?: "required" | "behavior";
};

const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const UPLOAD_MAX_BODY_BYTES = 6 * 1024 * 1024;

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isPlaceholderLike(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized.includes("replace_with")
    || normalized.includes("example.com")
    || normalized.includes("example.workers.dev")
    || normalized.includes("example.pages.dev");
}

async function checkExecutorBehavior(service: Fetcher | undefined, id: string): Promise<DeployReadinessCheck | null> {
  if (!service) return null;
  try {
    const res = await service.fetch("https://internal.everycal/healthz", { method: "GET" });
    if (!res.ok) {
      return {
        id,
        ok: false,
        level: "behavior",
        detail: `Service binding healthcheck returned ${res.status}.`,
      };
    }
    const payload = await res.json<{ ok?: boolean }>();
    return {
      id,
      ok: Boolean(payload?.ok),
      level: "behavior",
      detail: "Service binding healthcheck must report ok=true.",
    };
  } catch {
    return {
      id,
      ok: false,
      level: "behavior",
      detail: "Service binding healthcheck failed to execute.",
    };
  }
}

async function evaluateDeployReadiness(env: CloudflareBindings): Promise<DeployReadinessCheck[]> {
  const checks: DeployReadinessCheck[] = [
    {
      id: "base_url",
      ok: !isPlaceholderLike(env.BASE_URL),
      detail: "BASE_URL must point to your real public Worker/API origin.",
    },
    {
      id: "cors_origin",
      ok: !isPlaceholderLike(env.CORS_ORIGIN),
      detail: "CORS_ORIGIN should include your real frontend origin(s).",
    },
    {
      id: "federation_private_key",
      ok: Boolean(env.ACTIVITYPUB_PRIVATE_KEY_PEM && env.ACTIVITYPUB_PRIVATE_KEY_PEM.trim()),
      detail: "ACTIVITYPUB_PRIVATE_KEY_PEM secret must be configured for signed federation delivery.",
    },
    {
      id: "jobs_queue",
      ok: Boolean(env.JOBS_QUEUE),
      detail: "JOBS_QUEUE binding is required for scheduled reminders/scrapers dispatch.",
    },
    {
      id: "reminders_executor",
      ok: Boolean(env.REMINDERS_SERVICE || env.REMINDERS_WEBHOOK_URL),
      detail: "Configure REMINDERS_SERVICE or REMINDERS_WEBHOOK_URL.",
    },
    {
      id: "scrapers_executor",
      ok: Boolean(env.SCRAPERS_SERVICE || env.SCRAPERS_WEBHOOK_URL),
      detail: "Configure SCRAPERS_SERVICE or SCRAPERS_WEBHOOK_URL.",
    },
  ];

  const remindersBehavior = await checkExecutorBehavior(env.REMINDERS_SERVICE, "reminders_executor_behavior");
  const scrapersBehavior = await checkExecutorBehavior(env.SCRAPERS_SERVICE, "scrapers_executor_behavior");
  if (remindersBehavior) checks.push(remindersBehavior);
  if (scrapersBehavior) checks.push(scrapersBehavior);

  return checks;
}

async function maybeHandleDeployReadiness(request: Request, env: CloudflareBindings): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/v1/system/deploy-readiness") return null;

  const checks = await evaluateDeployReadiness(env);
  const requiredFailures = checks.filter((check) => !check.ok);

  return withSecurityHeaders(new Response(JSON.stringify({
    ok: requiredFailures.length === 0,
    summary: {
      passing: checks.length - requiredFailures.length,
      failing: requiredFailures.length,
      total: checks.length,
    },
    checks,
  }), {
    status: requiredFailures.length === 0 ? 200 : 503,
    headers: { "content-type": "application/json" },
  }));
}

function allowedCorsOrigins(env: CloudflareBindings): string[] {
  const value = env.CORS_ORIGIN || env.BASE_URL || "";
  return value.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function resolveCorsOrigin(request: Request, env: CloudflareBindings): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = allowedCorsOrigins(env);
  if (allowed.includes("*")) return origin;
  return allowed.includes(origin) ? origin : null;
}

function applyCorsHeaders(headers: Headers, request: Request, env: CloudflareBindings): void {
  const url = new URL(request.url);
  if (!isApiPath(url.pathname)) return;
  const origin = resolveCorsOrigin(request, env);
  if (!origin) return;

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
}

function maybeHandleCorsPreflight(request: Request, env: CloudflareBindings): Response | null {
  const url = new URL(request.url);
  if (request.method !== "OPTIONS" || !isApiPath(url.pathname)) return null;

  const origin = resolveCorsOrigin(request, env);
  if (!origin) return new Response(null, { status: 403 });

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    request.headers.get("access-control-request-headers") || "content-type, authorization"
  );
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");

  return withSecurityHeaders(new Response(null, { status: 204, headers }));
}

function getBodySizeLimit(pathname: string): number {
  return pathname.startsWith("/api/v1/uploads") ? UPLOAD_MAX_BODY_BYTES : DEFAULT_MAX_BODY_BYTES;
}

function maybeEnforceBodyLimit(request: Request): Response | null {
  if (!["POST", "PUT", "PATCH"].includes(request.method.toUpperCase())) return null;
  const url = new URL(request.url);
  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (!Number.isFinite(contentLength)) return null;
  if (contentLength <= getBodySizeLimit(url.pathname)) return null;
  return withSecurityHeaders(new Response(JSON.stringify({ error: "request_body_too_large" }), {
    status: 413,
    headers: { "content-type": "application/json" },
  }));
}


type RateLimitPolicy = {
  max: number;
  windowMs: number;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitStore = new Map<string, RateLimitState>();

function resolveClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return "unknown";
}

function resolveRateLimitPolicy(pathname: string): RateLimitPolicy | null {
  if (pathname === "/api/v1/auth/login") return { max: 10, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/api/v1/auth/register") return { max: 10, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/api/v1/auth/request-email-change") return { max: 5, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/api/v1/auth/change-password") return { max: 5, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/api/v1/federation/fetch-actor") return { max: 10, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/api/v1/federation/search") return { max: 20, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/api/v1/events/sync") return { max: 60, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname.startsWith("/api/v1/events")) return { max: 30, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/api/v1/images/search") return { max: 60, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname.startsWith("/api/v1/uploads")) return { max: 30, windowMs: RATE_LIMIT_WINDOW_MS };
  if (pathname === "/inbox") return { max: 60, windowMs: RATE_LIMIT_WINDOW_MS };
  if (/^\/users\/[^/]+\/inbox$/.test(pathname)) return { max: 60, windowMs: RATE_LIMIT_WINDOW_MS };
  return null;
}

function pruneRateLimitStore(now: number): void {
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt <= now) rateLimitStore.delete(key);
  }
}

type RateLimitResult = {
  headers: Headers | null;
  response: Response | null;
};

function createRateLimitHeaders(max: number, count: number, resetAt: number, scope: "local" | "global_kv" | "global_do"): Headers {
  const headers = new Headers();
  headers.set("X-RateLimit-Limit", String(max));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, max - count)));
  headers.set("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  headers.set("X-RateLimit-Scope", scope);
  return headers;
}

function toBlockedRateLimitResponse(headers: Headers): Response {
  const blockedHeaders = new Headers(headers);
  blockedHeaders.set("content-type", "application/json");
  return withSecurityHeaders(new Response(JSON.stringify({ error: "too_many_requests" }), {
    status: 429,
    headers: blockedHeaders,
  }));
}

async function evaluateKvRateLimit(request: Request, policy: RateLimitPolicy, env: CloudflareBindings): Promise<RateLimitResult | null> {
  if (!env.RATE_LIMITS_KV) return null;
  const now = Date.now();
  const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
  const resetAt = windowStart + policy.windowMs;
  const url = new URL(request.url);
  const key = `rl:v1:${url.pathname}:${resolveClientIp(request)}:${windowStart}`;

  const existing = await env.RATE_LIMITS_KV.get(key);
  const count = Number.parseInt(existing || "0", 10) + 1;
  const expirationTtl = Math.max(1, Math.ceil(policy.windowMs / 1000) + 5);
  await env.RATE_LIMITS_KV.put(key, String(count), { expirationTtl });

  const headers = createRateLimitHeaders(policy.max, count, resetAt, "global_kv");
  if (count > policy.max) return { headers, response: toBlockedRateLimitResponse(headers) };
  return { headers, response: null };
}

type DurableRateLimitResult = {
  count: number;
  resetAt: number;
};

async function evaluateDurableRateLimit(request: Request, policy: RateLimitPolicy, env: CloudflareBindings): Promise<RateLimitResult | null> {
  if (!env.RATE_LIMITS_DO) return null;
  const url = new URL(request.url);
  const ip = resolveClientIp(request);
  const id = env.RATE_LIMITS_DO.idFromName(`${url.pathname}:${ip}`);
  const stub = env.RATE_LIMITS_DO.get(id);

  const res = await stub.fetch("https://rate-limit/hit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ windowMs: policy.windowMs }),
  });

  if (!res.ok) throw new Error(`rate_limit_do_failed_${res.status}`);
  const payload = await res.json<DurableRateLimitResult>();
  const count = Number.isFinite(payload.count) ? Number(payload.count) : policy.max + 1;
  const resetAt = Number.isFinite(payload.resetAt) ? Number(payload.resetAt) : Date.now() + policy.windowMs;

  const headers = createRateLimitHeaders(policy.max, count, resetAt, "global_do");
  if (count > policy.max) return { headers, response: toBlockedRateLimitResponse(headers) };
  return { headers, response: null };
}

async function evaluateLocalRateLimit(request: Request, policy: RateLimitPolicy): Promise<RateLimitResult> {
  const now = Date.now();
  if (rateLimitStore.size > 1000) pruneRateLimitStore(now);

  const url = new URL(request.url);
  const key = `${resolveClientIp(request)}:${url.pathname}`;
  let state = rateLimitStore.get(key);
  if (!state || state.resetAt <= now) {
    state = { count: 0, resetAt: now + policy.windowMs };
    rateLimitStore.set(key, state);
  }

  state.count += 1;
  const headers = createRateLimitHeaders(policy.max, state.count, state.resetAt, "local");
  if (state.count > policy.max) return { headers, response: toBlockedRateLimitResponse(headers) };
  return { headers, response: null };
}

async function evaluateRateLimit(request: Request, env: CloudflareBindings): Promise<RateLimitResult> {
  if (request.method.toUpperCase() === "OPTIONS") return { headers: null, response: null };
  const url = new URL(request.url);
  const policy = resolveRateLimitPolicy(url.pathname);
  if (!policy) return { headers: null, response: null };

  const durableResult = await evaluateDurableRateLimit(request, policy, env);
  if (durableResult) return durableResult;

  const kvResult = await evaluateKvRateLimit(request, policy, env);
  if (kvResult) return kvResult;

  return evaluateLocalRateLimit(request, policy);
}

const JOB_TYPES = ["reminders", "scrapers"] as const;
const MAX_JOB_ATTEMPTS = 3;

type JobType = (typeof JOB_TYPES)[number];

function isJobType(value: string): value is JobType {
  return JOB_TYPES.includes(value as JobType);
}

function createApp(env: CloudflareBindings) {
  return createUnifiedApp({
    storage: new CloudflareStorage(env),
    baseUrl: env.BASE_URL,
    sessionCookieName: env.SESSION_COOKIE_NAME || "everycal_session",
    hashPassword,
    verifyPassword,
    verifyInboxRequest: ({ request, activity }) => verifyInboxRequest({ request, activity }),
    deliverActivity: ({ inbox, activity, actorKeyId }) => deliverActivity({ env, inbox, activity, actorKeyId }),
    syncRemoteActorAndEvents: (actorUri) => syncRemoteActorAndEvents({ env, actorUri }),
  });
}

async function dispatchScheduledJobs(env: CloudflareBindings): Promise<void> {
  if (!env.JOBS_QUEUE) return;
  for (const type of JOB_TYPES) {
    await env.JOBS_QUEUE.send({ type, attempts: 0, enqueuedAt: new Date().toISOString(), jobId: crypto.randomUUID() });
  }
}

function getNativeJobService(type: JobType, env: CloudflareBindings): Fetcher | null {
  if (type === "reminders") return env.REMINDERS_SERVICE || null;
  if (type === "scrapers") return env.SCRAPERS_SERVICE || null;
  return null;
}

function getNativeJobPath(type: JobType): string {
  return `/jobs/${type}`;
}

async function runNativeQueueJob(type: JobType, env: CloudflareBindings, message: QueueMessageBody, attempts: number): Promise<boolean> {
  const service = getNativeJobService(type, env);
  if (!service) return false;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.JOBS_WEBHOOK_TOKEN) headers.authorization = `Bearer ${env.JOBS_WEBHOOK_TOKEN}`;

  const res = await service.fetch(`https://internal.everycal${getNativeJobPath(type)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type, source: "cloudflare-queue-native", at: new Date().toISOString(), attempts, jobId: message.jobId || null, enqueuedAt: message.enqueuedAt || null }),
  });

  if (!res.ok) throw new Error(`job_native_failed_${type}_${res.status}`);
  return true;
}

function getJobWebhookUrl(type: JobType, env: CloudflareBindings): string | null {
  if (type === "reminders") return env.REMINDERS_WEBHOOK_URL || null;
  if (type === "scrapers") return env.SCRAPERS_WEBHOOK_URL || null;
  return null;
}

async function runQueueJob(type: JobType, env: CloudflareBindings, message: QueueMessageBody, attempts: number): Promise<void> {
  const ranNatively = await runNativeQueueJob(type, env, message, attempts);
  if (ranNatively) return;

  const webhookUrl = getJobWebhookUrl(type, env);
  if (!webhookUrl) {
    console.log(`[queue] ${type} skipped: no native service or webhook configured`);
    return;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.JOBS_WEBHOOK_TOKEN) headers.authorization = `Bearer ${env.JOBS_WEBHOOK_TOKEN}`;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ type, source: "cloudflare-queue-webhook", at: new Date().toISOString(), attempts, jobId: message.jobId || null, enqueuedAt: message.enqueuedAt || null }),
  });

  if (!res.ok) {
    throw new Error(`job_webhook_failed_${type}_${res.status}`);
  }
}


function readAttemptCount(value: unknown): number | null {
  if (!Number.isFinite(value)) return null;
  const count = Number(value);
  if (count < 0) return null;
  return Math.floor(count);
}

function resolveJobAttempts(message: { body?: QueueMessageBody; attempts?: number }): number {
  const deliveryAttempt = readAttemptCount(message.attempts);
  if (deliveryAttempt !== null) return deliveryAttempt;
  const payloadAttempts = readAttemptCount(message.body?.attempts);
  return (payloadAttempts ?? 0) + 1;
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(300, Math.max(30, attempt * 30));
}

async function sendToDeadLetterQueue(body: QueueMessageBody, env: CloudflareBindings, reason: string): Promise<void> {
  if (!env.JOBS_DLQ) return;
  await env.JOBS_DLQ.send({ ...body, failedAt: new Date().toISOString(), reason });
}

async function handleQueueBatch(batch: MessageBatch<QueueMessageBody>, env: CloudflareBindings): Promise<void> {
  for (const message of batch.messages) {
    const type = message.body?.type || "";
    const attempts = resolveJobAttempts(message as { body?: QueueMessageBody; attempts?: number });
    if (!isJobType(type)) {
      message.ack();
      continue;
    }
    try {
      await runQueueJob(type, env, message.body || {}, attempts);
      message.ack();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown_queue_failure";
      if (attempts >= MAX_JOB_ATTEMPTS) {
        await sendToDeadLetterQueue({ ...message.body, type, attempts }, env, reason);
        message.ack();
        continue;
      }
      if (typeof message.retry === "function") {
        message.retry({ delaySeconds: retryDelaySeconds(attempts) });
      } else {
        await sendToDeadLetterQueue({ ...message.body, type, attempts }, env, reason);
        message.ack();
      }
    }
  }
}


type DurableObjectStateLike = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete?(key: string): Promise<void>;
  };
};

export class RateLimitCoordinator {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const body = await request.json<{ windowMs?: number }>();
    const requestedWindow = Number.parseInt(String(body.windowMs ?? RATE_LIMIT_WINDOW_MS), 10);
    const windowMs = Number.isFinite(requestedWindow) && requestedWindow > 0 ? requestedWindow : RATE_LIMIT_WINDOW_MS;

    const now = Date.now();
    const current = await this.state.storage.get<{ count: number; resetAt: number }>("bucket");
    let bucket = current && current.resetAt > now
      ? { count: current.count, resetAt: current.resetAt }
      : { count: 0, resetAt: now + windowMs };

    bucket.count += 1;
    await this.state.storage.put("bucket", bucket);

    return new Response(JSON.stringify(bucket), {
      headers: { "content-type": "application/json" },
    });
  }
}


export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext): Promise<Response> {
    const readiness = await maybeHandleDeployReadiness(request, env);
    if (readiness) {
      const headers = new Headers(readiness.headers);
      applyCorsHeaders(headers, request, env);
      return new Response(readiness.body, { status: readiness.status, statusText: readiness.statusText, headers });
    }

    const preflight = maybeHandleCorsPreflight(request, env);
    if (preflight) return preflight;

    const bodyLimit = maybeEnforceBodyLimit(request);
    if (bodyLimit) return bodyLimit;

    const rateLimit = await evaluateRateLimit(request, env);
    if (rateLimit.response) {
      const headers = new Headers(rateLimit.response.headers);
      if (rateLimit.headers) {
        for (const [key, value] of rateLimit.headers.entries()) headers.set(key, value);
      }
      applyCorsHeaders(headers, request, env);
      return new Response(rateLimit.response.body, { status: rateLimit.response.status, statusText: rateLimit.response.statusText, headers });
    }

    const ssrResponse = await renderWorkerHtml(request, env);
    if (ssrResponse) {
      const secured = withSecurityHeaders(ssrResponse);
      const headers = new Headers(secured.headers);
      if (rateLimit.headers) {
        for (const [key, value] of rateLimit.headers.entries()) headers.set(key, value);
      }
      applyCorsHeaders(headers, request, env);
      return new Response(secured.body, { status: secured.status, statusText: secured.statusText, headers });
    }

    const app = createApp(env);
    const response = await app.fetch(request, env, ctx);
    const secured = withSecurityHeaders(response);
    const headers = new Headers(secured.headers);
    if (rateLimit.headers) {
      for (const [key, value] of rateLimit.headers.entries()) headers.set(key, value);
    }
    applyCorsHeaders(headers, request, env);
    return new Response(secured.body, { status: secured.status, statusText: secured.statusText, headers });
  },
  async scheduled(_controller: ScheduledController, env: CloudflareBindings): Promise<void> {
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
    await dispatchScheduledJobs(env);
  },
  async queue(batch: MessageBatch<QueueMessageBody>, env: CloudflareBindings): Promise<void> {
    await handleQueueBatch(batch, env);
  },
};
