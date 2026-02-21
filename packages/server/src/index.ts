/**
 * EveryCal Server — entry point.
 *
 * Lightweight Hono-based HTTP server with SQLite storage.
 * Full ActivityPub federation support.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
// Load .env from monorepo root (when running via pnpm dev) or server package dir
config({ path: resolve(process.cwd(), "../../.env") });
config();
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { secureHeaders } from "hono/secure-headers";
import { initDatabase } from "./db.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { authRoutes } from "./routes/auth.js";
import { eventRoutes } from "./routes/events.js";
import { feedRoutes } from "./routes/feeds.js";
import { userRoutes } from "./routes/users.js";
import { uploadRoutes } from "./routes/uploads.js";
import { wellKnownRoutes, nodeInfoRoutes } from "./routes/well-known.js";
import { activityPubRoutes, activityPubEventRoutes, sharedInboxRoute } from "./routes/activitypub.js";
import { federationRoutes } from "./routes/federation-api.js";
import { directoryRoutes } from "./routes/directory.js";
import { locationRoutes } from "./routes/locations.js";
import { imageRoutes } from "./routes/images.js";
import { serveUploadsRoutes } from "./routes/serve-uploads.js";
import { cleanupExpiredSessions } from "./middleware/auth.js";

const app = new Hono();
const db = initDatabase(process.env.DATABASE_PATH || "everycal.db");

// Security headers with Content-Security-Policy
app.use("*", secureHeaders({
  contentSecurityPolicy: process.env.NODE_ENV === "production" ? {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "https:", "data:"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  } : undefined,
}));

// Request body size limits (before any route parsing)
app.use("*", async (c, next) => {
  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  const path = c.req.path;
  // Uploads have their own 5MB limit in the upload handler
  const maxSize = path.startsWith("/api/v1/uploads") ? 6 * 1024 * 1024 : 1024 * 1024; // 1MB default
  if (contentLength > maxSize) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

// CORS — CORS_ORIGIN if set, else BASE_URL (same-origin in Docker/prod), else localhost:5173 (Vite dev)
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.BASE_URL || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

app.use(
  "/api/*",
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : ""),
    credentials: true,
  })
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

// Serve uploads with on-the-fly re-encoding (strip metadata, compress, cap dimensions)
app.route("/uploads", serveUploadsRoutes());

// Auth
app.route("/api/v1/auth", authRoutes(db));

// API routes
app.route("/api/v1/events", eventRoutes(db));
app.route("/api/v1/feeds", feedRoutes(db));
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

// Serve web frontend (production only) — must be last to not override API routes
if (process.env.NODE_ENV === "production") {
  // Serve static assets from /packages/web/dist
  app.use("*", serveStatic({ root: "./packages/web/dist" }));
  
  // SPA fallback — serve index.html for all non-API routes (client-side routing)
  app.get("*", serveStatic({ path: "./packages/web/dist/index.html" }));
}

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`🗓️  EveryCal server starting on http://localhost:${port}`);

serve({ fetch: app.fetch, port });

// Periodic session cleanup (every hour)
cleanupExpiredSessions(db);
setInterval(() => cleanupExpiredSessions(db), 3600_000);
