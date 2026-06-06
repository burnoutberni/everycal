import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../src/db.js";
import { processAdminJobQueue } from "../src/lib/admin-jobs.js";

describe("admin job worker", () => {
  const originalBaseUrl = process.env.BASE_URL;

  beforeEach(() => {
    process.env.BASE_URL = "http://localhost:3000";
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = originalBaseUrl;
  });

  it("claims queued scraper jobs and marks success with result JSON", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('admin1', 'admin', 1)").run();
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, payload_json, created_by_account_id, created_at) VALUES ('job1', 'scraper', 'queued', ?, 'admin1', datetime('now'))")
      .run(JSON.stringify({ scraper: 'all', dryRun: true }));

    const seen: Array<{ id: string; scraper: string | null; dryRun: boolean }> = [];
    const result = await processAdminJobQueue(db, 5, async (job) => {
      seen.push({ id: job.id, scraper: job.payload.scraper, dryRun: job.payload.dryRun });
      return { ok: true, scraper: job.payload.scraper ?? 'all', dryRun: job.payload.dryRun };
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(seen).toEqual([{ id: 'job1', scraper: null, dryRun: true }]);

    const row = db.prepare("SELECT status, started_at, finished_at, result_json FROM admin_job_runs WHERE id = 'job1'").get() as {
      status: string;
      started_at: string | null;
      finished_at: string | null;
      result_json: string | null;
    };
    expect(row.status).toBe("succeeded");
    expect(row.started_at).toBeTruthy();
    expect(row.finished_at).toBeTruthy();
    expect(JSON.parse(row.result_json || "null")).toEqual({ ok: true, scraper: 'all', dryRun: true });
  });

  it("coalesces overlapping queue runs in process", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('admin1', 'admin', 1)").run();
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, payload_json, created_by_account_id, created_at) VALUES ('job1', 'scraper', 'queued', ?, 'admin1', datetime('now'))")
      .run(JSON.stringify({ scraper: null, dryRun: false }));

    let resolveJob: (() => void) | null = null;
    let callCount = 0;
    const executor = async () => {
      callCount++;
      await new Promise<void>((resolve) => {
        resolveJob = resolve;
      });
      return { ok: true };
    };

    const run1 = processAdminJobQueue(db, 1, executor);
    const run2 = processAdminJobQueue(db, 1, executor);
    for (let i = 0; i < 20 && callCount === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(callCount).toBe(1);
    expect(resolveJob).not.toBeNull();
    resolveJob?.();

    const [result1, result2] = await Promise.all([run1, run2]);
    expect(result1).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(result2).toEqual({ processed: 1, succeeded: 1, failed: 0 });
  });

  it("reclaims stale running jobs but leaves fresh running jobs alone", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('admin1', 'admin', 1)").run();
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, payload_json, created_by_account_id, created_at, started_at) VALUES ('stale', 'scraper', 'running', ?, 'admin1', datetime('now', '-30 minutes'), datetime('now', '-20 minutes'))")
      .run(JSON.stringify({ scraper: 'stale-source', dryRun: false }));
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, payload_json, created_by_account_id, created_at, started_at) VALUES ('fresh', 'scraper', 'running', ?, 'admin1', datetime('now', '-10 minutes'), datetime('now'))")
      .run(JSON.stringify({ scraper: 'fresh-source', dryRun: false }));
    db.prepare("INSERT INTO admin_job_runs (id, job_type, status, payload_json, created_by_account_id, created_at) VALUES ('queued', 'scraper', 'queued', ?, 'admin1', datetime('now', '-5 minutes'))")
      .run(JSON.stringify({ scraper: 'queued-source', dryRun: true }));

    const processedIds: string[] = [];
    const result = await processAdminJobQueue(db, 5, async (job) => {
      processedIds.push(job.id);
      return { ok: true };
    });

    expect(result).toEqual({ processed: 2, succeeded: 2, failed: 0 });
    expect(processedIds.sort()).toEqual(['queued', 'stale']);

    const staleRow = db.prepare("SELECT status, started_at, finished_at FROM admin_job_runs WHERE id = 'stale'").get() as {
      status: string;
      started_at: string | null;
      finished_at: string | null;
    };
    expect(staleRow.status).toBe('succeeded');
    expect(staleRow.started_at).toBeTruthy();
    expect(staleRow.finished_at).toBeTruthy();

    const freshRow = db.prepare("SELECT status, started_at, finished_at FROM admin_job_runs WHERE id = 'fresh'").get() as {
      status: string;
      started_at: string | null;
      finished_at: string | null;
    };
    expect(freshRow.status).toBe('running');
    expect(freshRow.started_at).toBeTruthy();
    expect(freshRow.finished_at).toBeNull();
  });
});
