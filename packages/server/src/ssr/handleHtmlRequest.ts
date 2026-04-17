import type { Context, Next } from "hono";
import { renderPage } from "vike/server";
import type { DB } from "../db.js";
import { getSsrInitialData } from "../lib/ssr-data.js";
import { resolveBootstrap } from "../lib/bootstrap.js";
import { buildLocaleCookie, shouldSetLocaleCookie } from "../lib/locale.js";
import {
  buildSsrCacheKey,
  cacheAnonymousSsrResponse,
  getCachedSsrResponse,
  type CachedSsrResponse,
} from "./cache.js";

type HandleHtmlRequestInput = {
  db: DB;
  ssrAnonymousCache: Map<string, CachedSsrResponse>;
  anonymousCacheTtlMs: number;
};

export async function handleHtmlRequest(
  c: Context,
  next: Next,
  input: HandleHtmlRequestInput
) {
  const startedAt = Date.now();
  const bootstrap = resolveBootstrap(c, input.db);
  const authenticated = bootstrap.isAuthenticated;
  const cacheKey = buildSsrCacheKey(c.req.url, bootstrap.locale, authenticated);
  const requestCookieHeader = c.req.header("cookie");
  const shouldWriteLocaleCookie = shouldSetLocaleCookie(requestCookieHeader, bootstrap.locale);

  if (!authenticated && input.anonymousCacheTtlMs > 0) {
    const cached = getCachedSsrResponse(input.ssrAnonymousCache, cacheKey);
    if (cached) {
      cached.headers.forEach(([name, value]) => c.header(name, value));
      if (shouldWriteLocaleCookie) {
        c.header("Set-Cookie", buildLocaleCookie(bootstrap.locale), { append: true });
      }
      c.header("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=30");
      c.header("Vary", "Cookie, Authorization");
      c.header("X-SSR-Cache", "HIT");
      c.header("Server-Timing", `ssr;dur=${Date.now() - startedAt}`);
      attachBootstrapDiagnostics(c, bootstrap.locale, authenticated, "server-resolver", "HIT");
      c.status(cached.statusCode as never);
      return c.text(cached.body);
    }
  }

  const pageContextInit = {
    urlOriginal: c.req.url,
    headersOriginal: c.req.header(),
    initialData: getSsrInitialData(input.db, new URL(c.req.url).pathname, c.get("user")),
    bootstrap,
  };

  const pageContext = await renderPage(pageContextInit);
  const { httpResponse } = pageContext;
  if (!httpResponse) {
    return next();
  }

  const { body, statusCode, headers } = httpResponse;
  headers.forEach(([name, value]) => c.header(name, value));

  const isHtmlResponse = headers.some(
    ([name, value]) => name.toLowerCase() === "content-type" && value.toLowerCase().includes("text/html")
  );

  c.header("Vary", "Cookie, Authorization");
  if (isHtmlResponse && shouldWriteLocaleCookie) {
    c.header("Set-Cookie", buildLocaleCookie(bootstrap.locale), { append: true });
  }

  if (authenticated) {
    c.header("Cache-Control", "private, no-store");
    c.header("X-SSR-Cache", "BYPASS_AUTH");
  } else {
    c.header("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=30");
    c.header("X-SSR-Cache", "MISS");
  }

  const durationMs = Date.now() - startedAt;
  c.header("Server-Timing", `ssr;dur=${durationMs}`);
  const cacheState = authenticated ? "BYPASS_AUTH" : "MISS";
  attachBootstrapDiagnostics(c, bootstrap.locale, authenticated, "server-resolver", cacheState);

  console.log(
    `[SSR] ${c.req.method} ${cacheKey} status=${statusCode} auth=${authenticated ? "yes" : "no"} locale=${bootstrap.locale} dur=${durationMs}ms`
  );

  if (!authenticated && input.anonymousCacheTtlMs > 0 && statusCode === 200 && isHtmlResponse && typeof body === "string") {
    cacheAnonymousSsrResponse({
      cache: input.ssrAnonymousCache,
      key: cacheKey,
      body,
      statusCode,
      headers,
      ttlMs: input.anonymousCacheTtlMs,
    });
  }

  c.status(statusCode as never);
  return c.body(body);
}

function attachBootstrapDiagnostics(
  c: Context,
  locale: string,
  authenticated: boolean,
  source: string,
  cacheState: string
) {
  if (process.env.NODE_ENV === "production") return;
  // TODO(owner: platform): remove SSR_BOOTSTRAP_DEBUG diagnostics after rollout validation window.
  if (process.env.SSR_BOOTSTRAP_DEBUG !== "1") return;
  c.header("X-Everycal-Bootstrap", `source=${source};locale=${locale};auth=${authenticated ? "yes" : "no"};cache=${cacheState}`);
}
