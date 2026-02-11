/**
 * EveryCal Server — entry point.
 *
 * Lightweight Hono-based HTTP server with SQLite storage.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { initDatabase } from "./db.js";
import { eventRoutes } from "./routes/events.js";
import { feedRoutes } from "./routes/feeds.js";
import { wellKnownRoutes } from "./routes/well-known.js";

const app = new Hono();
const db = initDatabase(process.env.DATABASE_PATH || "everycal.db");

// Health check
app.get("/healthz", (c) => c.json({ status: "ok" }));

// Public API — no auth required for public feeds
app.route("/api/v1/events", eventRoutes(db));
app.route("/api/v1/feeds", feedRoutes(db));

// ActivityPub / WebFinger
app.route("/.well-known", wellKnownRoutes(db));

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`🗓️  EveryCal server starting on http://localhost:${port}`);

serve({ fetch: app.fetch, port });
