import { beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("executeScraperAdminJob", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("resolves the scraper script relative to the server module, not cwd", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.emit("close", 0, null);
      });
      return child;
    });

    const { executeScraperAdminJob } = await import("../src/lib/admin-jobs.js");
    const result = await executeScraperAdminJob({
      id: "job1",
      jobType: "scraper",
      payload: {
        scraper: "demo-source",
        dryRun: true,
      },
    });

    const testsDir = dirname(fileURLToPath(import.meta.url));
    const expectedScriptPath = resolve(testsDir, "../../scrapers/dist/run.js");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("node", [expectedScriptPath], {
      cwd: process.cwd(),
      env: expect.objectContaining({
        SCRAPER_DRY_RUN: "true",
        SCRAPER_IDS: "demo-source",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result).toEqual({
      scraper: "demo-source",
      dryRun: true,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
  });
});
