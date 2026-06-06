import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("executeScraperAdminJob", () => {
  const originalScraperApiKeysFile = process.env.SCRAPER_API_KEYS_FILE;

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (originalScraperApiKeysFile === undefined) delete process.env.SCRAPER_API_KEYS_FILE;
    else process.env.SCRAPER_API_KEYS_FILE = originalScraperApiKeysFile;
  });

  it("resolves the scraper script relative to the server module, not cwd", async () => {
    process.env.SCRAPER_API_KEYS_FILE = "./scraper-api-keys.json";
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
    const expectedApiKeysPath = resolve(testsDir, "../../..", "scraper-api-keys.json");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("node", [expectedScriptPath], {
      cwd: process.cwd(),
      env: expect.objectContaining({
        SCRAPER_DRY_RUN: "true",
        SCRAPER_IDS: "demo-source",
        SCRAPER_API_KEYS_FILE: expectedApiKeysPath,
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
