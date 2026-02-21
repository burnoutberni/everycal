/**
 * Job registry: name → script path (relative to monorepo root) and cron schedule.
 */

export const JOBS = {
  scrapers: {
    script: "packages/scrapers/dist/run.js",
    schedule: "0 */6 * * *", // every 6 hours
  },
  reminders: {
    script: "packages/server/dist/jobs/send-reminders.js",
    schedule: "*/15 * * * *", // every 15 minutes
  },
} as const;

export type JobName = keyof typeof JOBS;
