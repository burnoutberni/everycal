/**
 * EveryCal Server — entry point.
 *
 * Lightweight Hono-based HTTP server with SQLite storage.
 * Full ActivityPub federation support.
 */

import { config } from "dotenv";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Load .env from monorepo root (when running via pnpm dev) or server package dir
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });
config({ quiet: true });
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { initDatabase } from "./db.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { authRoutes } from "./routes/auth.js";
import { eventRoutes } from "./routes/events.js";
import { feedRoutes } from "./routes/feeds.js";
import { privateFeedRoutes } from "./routes/private-feeds.js";
import { identityRoutes } from "./routes/identities.js";
import { userRoutes } from "./routes/users.js";
import { uploadRoutes } from "./routes/uploads.js";
import { wellKnownRoutes, nodeInfoRoutes } from "./routes/well-known.js";
import { activityPubRoutes, activityPubEventRoutes, sharedInboxRoute } from "./routes/activitypub.js";
import { federationRoutes } from "./routes/federation-api.js";
import { directoryRoutes } from "./routes/directory.js";
import { locationRoutes } from "./routes/locations.js";
import { imageRoutes } from "./routes/images.js";
import { serveUploadsRoutes } from "./routes/serve-uploads.js";
import { serveOgImagesRoutes } from "./routes/serve-og-images.js";
import { cleanupExpiredSessions } from "./middleware/auth.js";
import { getLocale, t } from "./lib/i18n.js";
import { DATABASE_PATH } from "./lib/paths.js";
import { handleHtmlRequest } from "./ssr/handleHtmlRequest.js";
import type { CachedSsrResponse } from "./ssr/cache.js";
import { resolveBootstrap } from "./lib/bootstrap.js";
import { buildLocaleCookie, shouldSetLocaleCookie } from "./lib/locale.js";
import { createDevMiddleware } from "vike/server";
import { createApiCorsMiddleware } from "./middleware/api-cors.js";
import { createEmbedCorpMiddleware } from "./middleware/embed-corp.js";

const app = new Hono();
const db = initDatabase(DATABASE_PATH);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, "../../web");

const SSR_ANON_CACHE_TTL_MS = Math.max(0, parseInt(process.env.SSR_ANON_CACHE_TTL_MS || "15000", 10));
const ssrAnonymousCache = new Map<string, CachedSsrResponse>();

// Security headers with Content-Security-Policy
app.use("*", secureHeaders({
  contentSecurityPolicy: process.env.NODE_ENV === "production" ? {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "https:", "data:"],
    connectSrc: ["'self'", "https://photon.komoot.io"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  } : undefined,
  crossOriginResourcePolicy: false,
}));

// Keep strict CORP by default, but allow the public embed script cross-origin.
app.use("*", createEmbedCorpMiddleware());

// Request body size limits (stream-aware, works for chunked transfer)
app.use("/api/v1/uploads*", bodyLimit({
  maxSize: 6 * 1024 * 1024,
  onError: (c) => c.json({ error: t(getLocale(c), "common.request_body_too_large") }, 413),
}));
const defaultApiBodyLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.json({ error: t(getLocale(c), "common.request_body_too_large") }, 413),
});
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/uploads")) {
    await next();
    return;
  }
  return defaultApiBodyLimit(c, next);
});

// CORS — CORS_ORIGIN if set, else BASE_URL (same-origin in Docker/prod), else localhost:5173 (Vite dev)
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.BASE_URL || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

app.use(
  "/api/*",
  createApiCorsMiddleware(allowedOrigins)
);

// Rate limiting on auth endpoints (prevent brute force)
app.use("/api/v1/auth/login", rateLimiter({ windowMs: 60_000, max: 10 }));
app.use("/api/v1/auth/register", rateLimiter({ windowMs: 60_000, max: 10 }));
app.use("/api/v1/auth/request-email-change", rateLimiter({ windowMs: 60_000, max: 5 }));
app.use("/api/v1/auth/change-password", rateLimiter({ windowMs: 60_000, max: 5 }));

// Rate limiting on federation fetch (prevent SSRF abuse)
app.use("/api/v1/federation/fetch-actor", rateLimiter({ windowMs: 60_000, max: 10 }));
app.use("/api/v1/federation/search", rateLimiter({ windowMs: 60_000, max: 20 }));

// Rate limiting on event sync (prevent abuse by compromised scraper keys)
app.use("/api/v1/events/sync", rateLimiter({ windowMs: 60_000, max: 60 }));

// Rate limiting on event creation/update (prevent spam)
app.use("/api/v1/events", rateLimiter({ windowMs: 60_000, max: 30 }));

// Rate limiting on image search (proxy to external APIs)
app.use("/api/v1/images/search", rateLimiter({ windowMs: 60_000, max: 60 }));

// Rate limiting on uploads (prevent disk fill)
app.use("/api/v1/uploads", rateLimiter({ windowMs: 60_000, max: 30 }));

// Rate limiting on ActivityPub inboxes (prevent federation abuse)
app.use("/users/*/inbox", rateLimiter({ windowMs: 60_000, max: 60 }));
app.use("/inbox", rateLimiter({ windowMs: 60_000, max: 60 }));

// Auth middleware — runs on all routes, sets c.get("user") or null
app.use("*", authMiddleware(db));

// Health check
app.get("/healthz", (c) => c.json({ status: "ok" }));

app.get("/api/v1/bootstrap", (c) => {
  const bootstrap = resolveBootstrap(c, db);
  if (shouldSetLocaleCookie(c.req.header("cookie"), bootstrap.locale)) {
    c.header("Set-Cookie", buildLocaleCookie(bootstrap.locale), { append: true });
  }
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie, Authorization, Accept-Language");
  return c.json(bootstrap);
});

// Serve uploads with on-the-fly re-encoding (strip metadata, compress, cap dimensions)
app.route("/uploads", serveUploadsRoutes());

// Serve OG images
app.route("/og-images", serveOgImagesRoutes());

// Auth
app.route("/api/v1/auth", authRoutes(db));

// API routes
app.route("/api/v1/events", eventRoutes(db));
app.route("/api/v1/feeds", feedRoutes(db));
app.route("/api/v1/private-feeds", privateFeedRoutes(db));
app.route("/api/v1/identities", identityRoutes(db));
app.route("/api/v1/users", userRoutes(db));
app.route("/api/v1", directoryRoutes(db));
app.route("/api/v1/uploads", uploadRoutes());
app.route("/api/v1/locations", locationRoutes(db));
app.route("/api/v1/images", imageRoutes());
app.route("/api/v1/federation", federationRoutes(db));

// ActivityPub / WebFinger / NodeInfo
app.route("/.well-known", wellKnownRoutes(db));
app.route("/nodeinfo", nodeInfoRoutes(db));

// ActivityPub actor routes (must handle content negotiation)
app.route("/users", activityPubRoutes(db));

// ActivityPub event objects (for federation — /events/:id)
app.route("/events", activityPubEventRoutes(db));

// Shared inbox for federation
app.route("/", sharedInboxRoute(db));

// Serve web frontend assets (production) — must be last to not override API routes
if (process.env.NODE_ENV === "production") {
  // Serve static assets from generic dist (old setup) and new Vike dist/client
  app.use("*", serveStatic({ root: "./packages/web/dist" }));
  app.use("*", serveStatic({ root: "./packages/web/dist/client" }));
}

if (process.env.NODE_ENV !== "production") {
  console.log(`[DEV] Using in-process Vite middleware at ${WEB_ROOT}`);
}

// Hand off all other document requests to Vike SSR
app.get("*", async (c, next) => {
  return handleHtmlRequest(c, next, {
    db,
    ssrAnonymousCache,
    anonymousCacheTtlMs: SSR_ANON_CACHE_TTL_MS,
  });
});

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`🗓️  EveryCal server starting on http://localhost:${port}`);

type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void
) => void;

function getPathname(req: IncomingMessage): string {
  const rawUrl = req.url || "/";
  try {
    return new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function shouldBypassViteDevMiddleware(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/uploads") ||
    pathname.startsWith("/og-images") ||
    pathname.startsWith("/.well-known") ||
    pathname.startsWith("/users") ||
    pathname.startsWith("/events") ||
    pathname.startsWith("/nodeinfo") ||
    pathname === "/inbox"
  );
}

let viteDevMiddleware: NodeMiddleware | null = null;

if (process.env.NODE_ENV !== "production") {
  process.env.EVERYCAL_IN_PROCESS_VITE = "1";
  const { devMiddleware } = await createDevMiddleware({ root: WEB_ROOT });
  viteDevMiddleware = devMiddleware as unknown as NodeMiddleware;
}

const honoRequestListener = getRequestListener(app.fetch);

const server = createServer((req, res) => {
  const pathname = getPathname(req);
  if (shouldBypassViteDevMiddleware(pathname)) {
    void honoRequestListener(req, res);
    return;
  }

  if (viteDevMiddleware) {
    viteDevMiddleware(req, res, (error?: unknown) => {
      if (error) {
        console.error("[DEV] Vite middleware error", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Vite middleware error");
        }
        return;
      }
      if (!res.writableEnded) {
        void honoRequestListener(req, res);
      }
    });
    return;
  }

  void honoRequestListener(req, res);
});

server.listen(port);

// Periodic session cleanup (every hour)
cleanupExpiredSessions(db);
setInterval(() => cleanupExpiredSessions(db), 3600_000);
