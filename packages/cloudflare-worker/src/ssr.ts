import { renderPage } from "vike/server";
import type { CloudflareBindings } from "./storage";
import { CloudflareStorage } from "./storage";

const INTERNAL_API_ORIGIN_KEY = "__EVERYCAL_INTERNAL_API_ORIGIN";
const SESSION_COOKIE_FALLBACK = "everycal_session";

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function buildAnonymousSsrCacheControl(env: CloudflareBindings): string {
  const sMaxAge = readPositiveInt(env.SSR_CACHE_MAX_AGE_SECONDS, 15);
  const staleWhileRevalidate = readPositiveInt(env.SSR_CACHE_STALE_WHILE_REVALIDATE_SECONDS, 30);
  return `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`;
}

function isEdgeCacheEnabled(env: CloudflareBindings): boolean {
  return env.SSR_EDGE_CACHE_ENABLED !== "false";
}

function edgeCacheTag(env: CloudflareBindings): string {
  const version = (env.SSR_CACHE_TAG_VERSION || "v1").trim() || "v1";
  return `everycal-ssr,everycal-ssr-anon,everycal-ssr-${version}`;
}

function shouldBypassAnonymousEdgeCache(request: Request, env: CloudflareBindings): boolean {
  const url = new URL(request.url);
  if (url.searchParams.has("preview") || url.searchParams.has("nocache")) return true;

  const cacheControl = (request.headers.get("cache-control") || "").toLowerCase();
  const pragma = (request.headers.get("pragma") || "").toLowerCase();
  if (cacheControl.includes("no-cache") || cacheControl.includes("no-store") || pragma.includes("no-cache")) return true;

  const bypassHeaderName = (env.SSR_EDGE_CACHE_BYPASS_HEADER || "x-everycal-ssr-bypass").toLowerCase();
  const bypassHeaderValue = request.headers.get(bypassHeaderName);
  return typeof bypassHeaderValue === "string" && bypassHeaderValue.trim().length > 0;
}

function getCookie(headers: Headers, name: string): string | null {
  const cookie = headers.get("cookie") || "";
  const parts = cookie.split(";").map((v) => v.trim());
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx) !== name) continue;
    const encoded = part.slice(idx + 1);
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return null;
}

async function resolveBootstrap(request: Request, env: CloudflareBindings) {
  const storage = new CloudflareStorage(env);
  const token = getCookie(request.headers, env.SESSION_COOKIE_NAME || SESSION_COOKIE_FALLBACK);
  const session = token ? await storage.getSession(token) : null;
  const account = session ? await storage.getAccountById(session.accountId) : null;

  return {
    locale: "en",
    isAuthenticated: Boolean(account),
    viewer: account
      ? {
          id: account.id,
          username: account.username,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
          discoverable: false,
          accountType: "person",
          roles: [],
        }
      : null,
  };
}

function shouldHandleWithSsr(request: Request): boolean {
  if (request.method !== "GET") return false;

  const accept = request.headers.get("accept") || "";
  if (!accept.includes("text/html")) return false;

  const url = new URL(request.url);
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/uploads") ||
    url.pathname.startsWith("/.well-known") ||
    url.pathname.startsWith("/users") ||
    url.pathname.startsWith("/events") ||
    url.pathname.startsWith("/nodeinfo") ||
    url.pathname === "/inbox" ||
    url.pathname === "/healthz"
  ) {
    return false;
  }

  return true;
}

export async function renderWorkerHtml(request: Request, env: CloudflareBindings): Promise<Response | null> {
  if (!shouldHandleWithSsr(request)) return null;

  const url = new URL(request.url);
  const previousOrigin = (globalThis as Record<string, unknown>)[INTERNAL_API_ORIGIN_KEY];
  (globalThis as Record<string, unknown>)[INTERNAL_API_ORIGIN_KEY] = `${url.protocol}//${url.host}`;

  try {
    const bootstrap = await resolveBootstrap(request, env);

    const pageContext = await renderPage({
      urlOriginal: request.url,
      headersOriginal: Object.fromEntries(request.headers.entries()),
      bootstrap,
      initialData: null,
    });

    const { httpResponse } = pageContext;
    if (!httpResponse) return null;

    const headers = new Headers();
    httpResponse.headers.forEach(([name, value]) => headers.set(name, value));
    headers.set("Vary", "Cookie, Authorization, Accept-Language, Cache-Control, Pragma");

    if (bootstrap.isAuthenticated) {
      headers.set("Cache-Control", "private, no-store");
      headers.set("CDN-Cache-Control", "private, no-store");
      headers.set("X-SSR-Cache", "BYPASS_AUTH");
    } else if (!isEdgeCacheEnabled(env)) {
      headers.set("Cache-Control", "public, max-age=0, no-store");
      headers.set("CDN-Cache-Control", "public, max-age=0, no-store");
      headers.set("X-SSR-Cache", "DISABLED");
    } else if (shouldBypassAnonymousEdgeCache(request, env)) {
      headers.set("Cache-Control", "public, max-age=0, no-store");
      headers.set("CDN-Cache-Control", "public, max-age=0, no-store");
      headers.set("X-SSR-Cache", "BYPASS_REQUEST");
    } else {
      const cacheControl = buildAnonymousSsrCacheControl(env);
      headers.set("Cache-Control", cacheControl);
      headers.set("CDN-Cache-Control", cacheControl);
      headers.set("Cache-Tag", edgeCacheTag(env));
      headers.set("X-SSR-Cache", "EDGE_HINT");
    }

    return new Response(httpResponse.body, {
      status: httpResponse.statusCode,
      headers,
    });
  } finally {
    if (typeof previousOrigin === "undefined") {
      delete (globalThis as Record<string, unknown>)[INTERNAL_API_ORIGIN_KEY];
    } else {
      (globalThis as Record<string, unknown>)[INTERNAL_API_ORIGIN_KEY] = previousOrigin;
    }
  }
}
