#!/usr/bin/env node
/**
 * Send event reminders — run-once job.
 * Invoked by everycal-job reminders (or reminders --once).
 */

import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env from monorepo root (cwd when run via everycal-job)
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "packages/server/.env") });
config();

import { initDatabase } from "../db.js";
import { runSendReminders } from "../lib/notifications.js";

const dbPath = process.env.DATABASE_PATH || resolve(process.cwd(), "packages/server/everycal.db");
const db = initDatabase(dbPath);

runSendReminders(db)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reminders job failed:", err);
    process.exit(1);
  });
