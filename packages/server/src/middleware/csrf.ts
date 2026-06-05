/**
 * General-purpose CSRF protection middleware (double-submit cookie pattern).
 *
 * Skips:
 *   - Safe HTTP methods (GET, HEAD, OPTIONS)
 *   - Non-cookie auth (Bearer / ApiKey)
 *   - Requests without a session cookie (server-side / unauthenticated)
 */

import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readCookie(headerValue: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = headerValue.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return match?.[1] ?? null;
}

function sameOrigin(origin: string | null, referer: string | null, allowedOrigins: Set<string>): boolean {
  if (origin) return allowedOrigins.has(origin);
  if (!referer) return false;
  try {
    return allowedOrigins.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

function hasOriginSignal(origin: string | null, referer: string | null): boolean {
  return Boolean(origin || referer);
}

/**
 * CSRF middleware that validates the double-submit cookie pattern.
 *
 * @param allowedOrigins - Origins allowed for same-origin checks (e.g. from {@link getAllowedAdminOrigins}).
 */
export function requireCsrf(allowedOrigins: Set<string>) {
  return createMiddleware(async (c, next) => {
    if (!UNSAFE_METHODS.has(c.req.method)) {
      await next();
      return undefined;
    }

    // API-key / Bearer callers are not browser-based — skip CSRF
    const authorization = c.req.header("authorization") || "";
    if (authorization.startsWith("Bearer ") || authorization.startsWith("ApiKey ")) {
      await next();
      return undefined;
    }

    // Only enforce CSRF for a valid cookie-auth session. Stale or invalid
    // session cookies should behave as unauthenticated requests so users can
    // still reach login and other auth entry points.
    const cookieHeader = c.req.header("cookie") || "";
    const sessionToken = readCookie(cookieHeader, "everycal_session");
    const cookieSessionExpiresAt = c.get("cookieSessionExpiresAt");
    if (!sessionToken || !cookieSessionExpiresAt) {
      await next();
      return undefined;
    }

    if (allowedOrigins.size === 0) {
      return c.json({ error: "csrf_origin_unconfigured" }, 403);
    }

    // Origin / Referer validation
    const origin = c.req.header("origin") || null;
    const referer = c.req.header("referer") || null;
    if (hasOriginSignal(origin, referer) && !sameOrigin(origin, referer, allowedOrigins)) {
      return c.json({ error: "csrf_origin_mismatch" }, 403);
    }

    // Double-submit cookie check: everycal_csrf cookie must match x-csrf-token header
    const csrfCookie = readCookie(cookieHeader, "everycal_csrf");
    const csrfHeader = c.req.header("x-csrf-token");
    if (!csrfCookie || !csrfHeader || !tokensEqual(csrfCookie, csrfHeader)) {
      return c.json({ error: "csrf_token_invalid" }, 403);
    }

    await next();
    return undefined;
  });
}
