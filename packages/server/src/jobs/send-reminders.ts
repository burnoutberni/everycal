#!/usr/bin/env node
/**
 * Send event reminders — run-once job.
 * Invoked by everycal-job reminders (or reminders --once).
 */

import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env from monorepo root (cwd when run via everycal-job)
config({ path: resolve(process.cwd(), ".env"), quiet: true });
config({ path: resolve(process.cwd(), "packages/server/.env"), quiet: true });
config({ quiet: true });

import { initDatabase } from "../db.js";
import { runSendReminders } from "../lib/notifications.js";
import { DATABASE_PATH } from "../lib/paths.js";

const db = initDatabase(DATABASE_PATH);

runSendReminders(db)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reminders job failed:", err);
    process.exit(1);
  });
