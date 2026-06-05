import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { toErrorMessage } from "@everycal/core";
import { fileURLToPath } from "node:url";
import type { DB } from "../db.js";
import { getEffectiveSetting } from "./runtime-settings.js";

const ADMIN_JOB_CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
const SCRAPER_TIMEOUT_MS = 5 * 60 * 1000;
const SCRAPER_OUTPUT_MAX_BYTES = 1024 * 1024;
const ADMIN_JOB_INTERVAL_MS_DEFAULT = 5000;
const adminJobQueueRuns = new WeakMap<DB, Promise<{ processed: number; succeeded: number; failed: number }>>();
const serverLibDir = dirname(fileURLToPath(import.meta.url));
const scraperScriptPath = resolve(serverLibDir, "../../../scrapers/dist/run.js");

export type AdminJobPayload = {
  scraper: string | null;
  dryRun: boolean;
};

type ClaimedAdminJob = {
  id: string;
  job_type: string;
  payload_json: string | null;
};

export type AdminJob = {
  id: string;
  jobType: string;
  payload: AdminJobPayload;
};

export type AdminJobExecutor = (job: AdminJob) => Promise<Record<string, unknown>>;

class AdminJobExecutionError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, result: Record<string, unknown>) {
    super(message);
    this.name = "AdminJobExecutionError";
    this.result = result;
  }
}

function parseIntervalMs(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  if (!Number.isFinite(parsed)) return ADMIN_JOB_INTERVAL_MS_DEFAULT;
  return Math.max(1000, parsed);
}

function parsePayload(payloadJson: string | null): AdminJobPayload {
  if (!payloadJson) return { scraper: null, dryRun: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("invalid stored admin job payload JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid stored admin job payload");
  }
  const payload = parsed as Record<string, unknown>;
  const scraper = typeof payload.scraper === "string" && payload.scraper.trim() ? payload.scraper.trim() : null;
  return {
    scraper: scraper === "all" ? null : scraper,
    dryRun: payload.dryRun === true,
  };
}

export async function executeScraperAdminJob(job: AdminJob): Promise<Record<string, unknown>> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SCRAPER_DRY_RUN: job.payload.dryRun ? "true" : "false",
  };
  if (job.payload.scraper) env.SCRAPER_IDS = job.payload.scraper;
  else delete env.SCRAPER_IDS;

  return await new Promise((resolvePromise, reject) => {
    const child = spawn("node", [scraperScriptPath], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, SCRAPER_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < SCRAPER_OUTPUT_MAX_BYTES) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < SCRAPER_OUTPUT_MAX_BYTES) stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AdminJobExecutionError("failed to start scraper job", {
        scraper: job.payload.scraper ?? "all",
        dryRun: job.payload.dryRun,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: toErrorMessage(err, "failed to start scraper job"),
      }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        scraper: job.payload.scraper ?? "all",
        dryRun: job.payload.dryRun,
        exitCode: code,
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (killed) {
        reject(new AdminJobExecutionError("scraper job timed out", result));
        return;
      }
      if (code === 0) {
        resolvePromise(result);
        return;
      }
      reject(new AdminJobExecutionError(`scraper job exited with code ${code ?? "unknown"}`, result));
    });
  });
}

export async function executeAdminJob(job: AdminJob): Promise<Record<string, unknown>> {
  if (job.jobType === "scraper") {
    return executeScraperAdminJob(job);
  }
  throw new Error(`unsupported admin job type: ${job.jobType}`);
}

export async function processAdminJobQueue(
  db: DB,
  limit = 1,
  executor: AdminJobExecutor = executeAdminJob,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const existingRun = adminJobQueueRuns.get(db);
  if (existingRun) return existingRun;

  const run = (async () => {
    const staleClaimBefore = new Date(Date.now() - ADMIN_JOB_CLAIM_TIMEOUT_MS).toISOString().replace("T", " ").slice(0, 19);
    const claimJobs = db.transaction((batchLimit: number, staleClaimCutoff: string) => {
      db.prepare(
        `UPDATE admin_job_runs
         SET status = 'queued', started_at = NULL, finished_at = NULL
         WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?`,
      ).run(staleClaimCutoff);

      return db.prepare(
        `UPDATE admin_job_runs
         SET status = 'running', started_at = datetime('now'), finished_at = NULL, result_json = NULL
         WHERE id IN (
           SELECT id
           FROM admin_job_runs
           WHERE status = 'queued'
           ORDER BY created_at, id
           LIMIT ?
         )
           AND status = 'queued'
         RETURNING id, job_type, payload_json`,
      ).all(batchLimit) as ClaimedAdminJob[];
    });

    const jobs = claimJobs(limit, staleClaimBefore);
    let succeeded = 0;
    let failed = 0;
    for (const row of jobs) {
      try {
        const job: AdminJob = {
          id: row.id,
          jobType: row.job_type,
          payload: parsePayload(row.payload_json),
        };
        const result = await executor(job);
        db.prepare(
          "UPDATE admin_job_runs SET status = 'succeeded', result_json = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'"
        ).run(JSON.stringify(result), row.id);
        succeeded++;
      } catch (err) {
        const baseResult = err instanceof AdminJobExecutionError ? err.result : {};
        const result = {
          ...baseResult,
          error: toErrorMessage(err, "admin job failed"),
        };
        db.prepare(
          "UPDATE admin_job_runs SET status = 'failed', result_json = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'"
        ).run(JSON.stringify(result), row.id);
        failed++;
      }
    }
    return { processed: jobs.length, succeeded, failed };
  })();

  adminJobQueueRuns.set(db, run);
  try {
    return await run;
  } finally {
    if (adminJobQueueRuns.get(db) === run) adminJobQueueRuns.delete(db);
  }
}

export function startAdminJobWorker(db: DB): NodeJS.Timeout | null {
  if (!getEffectiveSetting<boolean>(db, "run_jobs_internally", true)) {
    return null;
  }

  const intervalMs = parseIntervalMs(process.env.ADMIN_JOB_INTERVAL_MS);
  const run = () => {
    processAdminJobQueue(db).catch((err) => console.error("[Admin] admin job worker failed", err));
  };

  run();
  return setInterval(run, intervalMs);
}
