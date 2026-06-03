import { createMiddleware } from "hono/factory";
import { getAllowedAdminOrigins } from "./admin-origins.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

export function requireAdminCsrf() {
  const allowedOrigins = getAllowedAdminOrigins();

  return createMiddleware(async (c, next) => {
    if (!UNSAFE_METHODS.has(c.req.method)) {
      await next();
      return undefined;
    }

    const authorization = c.req.header("authorization") || "";
    if (authorization.startsWith("Bearer ") || authorization.startsWith("ApiKey ")) {
      await next();
      return undefined;
    }

    const cookieHeader = c.req.header("cookie") || "";
    const sessionToken = readCookie(cookieHeader, "everycal_session");
    if (!sessionToken) {
      await next();
      return undefined;
    }

    if (allowedOrigins.size === 0) {
      return c.json({ error: "csrf_origin_unconfigured" }, 403);
    }

    const origin = c.req.header("origin") || null;
    const referer = c.req.header("referer") || null;
    if (hasOriginSignal(origin, referer) && !sameOrigin(origin, referer, allowedOrigins)) {
      return c.json({ error: "csrf_origin_mismatch" }, 403);
    }

    const csrfCookie = readCookie(cookieHeader, "everycal_csrf");
    const csrfHeader = c.req.header("x-csrf-token");
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return c.json({ error: "csrf_token_invalid" }, 403);
    }

    await next();
    return undefined;
  });
}
