/**
 * EveryCal Server — entry point.
 *
 * Lightweight Hono-based HTTP server with SQLite storage.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { initDatabase } from "./db.js";
import { authMiddleware } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { eventRoutes } from "./routes/events.js";
import { feedRoutes } from "./routes/feeds.js";
import { userRoutes } from "./routes/users.js";
import { uploadRoutes } from "./routes/uploads.js";
import { wellKnownRoutes } from "./routes/well-known.js";

const app = new Hono();
const db = initDatabase(process.env.DATABASE_PATH || "everycal.db");

// CORS for frontend dev server
app.use(
  "/api/*",
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);

// Auth middleware — runs on all routes, sets c.get("user") or null
app.use("*", authMiddleware(db));

// Health check
app.get("/healthz", (c) => c.json({ status: "ok" }));

// Static file serving for uploads
app.use("/uploads/*", serveStatic({ root: "./" }));

// Auth
app.route("/api/v1/auth", authRoutes(db));

// API routes
app.route("/api/v1/events", eventRoutes(db));
app.route("/api/v1/feeds", feedRoutes(db));
app.route("/api/v1/users", userRoutes(db));
app.route("/api/v1/uploads", uploadRoutes());

// ActivityPub / WebFinger
app.route("/.well-known", wellKnownRoutes(db));

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`🗓️  EveryCal server starting on http://localhost:${port}`);

serve({ fetch: app.fetch, port });
