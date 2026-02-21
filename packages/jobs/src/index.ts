#!/usr/bin/env node
/**
 * EveryCal unified job runner.
 *
 * Usage:
 *   everycal-job [all]           # run all jobs on schedule (default in Docker)
 *   everycal-job scrapers        # run scrapers on schedule
 *   everycal-job scrapers --once # run once, exit (for external cron)
 *   everycal-job reminders
 *   everycal-job reminders --once
 */

import cron from "node-cron";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { JOBS, type JobName } from "./registry.js";

const args = process.argv.slice(2);
const once = args.includes("--once");
const jobArg = args.find((a) => !a.startsWith("--")) || "all";

const jobNames: JobName[] =
  jobArg === "all" ? (Object.keys(JOBS) as JobName[]) : jobArg in JOBS ? [jobArg as JobName] : [];

if (jobNames.length === 0) {
  console.error(`Usage: everycal-job [all|scrapers|reminders] [--once]`);
  console.error(`Jobs: ${Object.keys(JOBS).join(", ")}`);
  process.exit(1);
}

// Resolve script path relative to monorepo root (cwd when run via pnpm from root or Docker /app)
const root = process.cwd();

function runJob(jobName: JobName): Promise<void> {
  const { script } = JOBS[jobName];
  const scriptPath = resolve(root, script);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [scriptPath], {
      stdio: "inherit",
      cwd: root,
      env: process.env,
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Job ${jobName} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function runAllJobs(): Promise<void> {
  for (const name of jobNames) {
    await runJob(name);
  }
}

if (once) {
  runAllJobs()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  console.log(`EveryCal job runner: ${jobNames.join(", ")} (node-cron)`);
  // Run scrapers once on startup (then every 6h via cron)
  if (jobNames.includes("scrapers")) {
    console.log(`[jobs] Running scrapers on startup...`);
    runJob("scrapers")
      .then(() => console.log(`[jobs] scrapers done`))
      .catch((err) => console.error(`Job scrapers failed:`, err));
  }
  for (const jobName of jobNames) {
    const { schedule } = JOBS[jobName];
    cron.schedule(schedule, () => {
      console.log(`[jobs] Running ${jobName}...`);
      runJob(jobName)
        .then(() => console.log(`[jobs] ${jobName} done`))
        .catch((err) => console.error(`Job ${jobName} failed:`, err));
    });
  }
  // Keep process alive (cron runs in background)
}
