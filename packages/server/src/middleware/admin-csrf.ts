import { createMiddleware } from "hono/factory";
import { getBaseUrl } from "../lib/base-url.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function readCookie(headerValue: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = headerValue.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return match?.[1] ?? null;
}

function sameOrigin(origin: string | null, referer: string | null, expectedOrigin: string): boolean {
  if (origin) return origin === expectedOrigin;
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function requireAdminCsrf() {
  let expectedOrigin = "";
  try {
    expectedOrigin = new URL(getBaseUrl()).origin;
  } catch {
    expectedOrigin = "";
  }

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

    if (!expectedOrigin) {
      return c.json({ error: "csrf_origin_unconfigured" }, 403);
    }

    const origin = c.req.header("origin") || null;
    const referer = c.req.header("referer") || null;
    if (!sameOrigin(origin, referer, expectedOrigin)) {
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
