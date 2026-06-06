import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "./registry.js";
import { selectRunScrapers } from "./lib/select-run-scrapers.js";

const packageDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function runScraper(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/run.ts"], {
      cwd: packageDir,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe("scraper runner", () => {
  it("defaults to configured scrapers when SCRAPER_IDS is unset", () => {
    const scrapers = selectRunScrapers({
      requestedScrapers: null,
      registry,
      apiKeys: {
        critical_mass_vienna: "test-key-1",
        flex_at: "test-key-2",
        unrelated: "ignored",
      },
    });

    expect(scrapers.map((scraper) => scraper.id)).toEqual(["flex_at", "critical_mass_vienna"]);
  });

  it("keeps explicit scraper requests strict even when other keys exist", () => {
    const requestedScrapers = [registry.find((scraper) => scraper.id === "radlobby_wien")!];

    const scrapers = selectRunScrapers({
      requestedScrapers,
      registry,
      apiKeys: {
        flex_at: "test-key",
      },
    });

    expect(scrapers.map((scraper) => scraper.id)).toEqual(["radlobby_wien"]);
  });

  it("fails when the configured API key file is missing", async () => {
    const result = await runScraper({
      SCRAPER_API_KEYS_FILE: resolve(packageDir, "missing-scraper-api-keys.json"),
      JOBS_API_SERVER: "http://localhost:3000",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SCRAPER_API_KEYS_FILE");
    expect(result.stderr).toContain("not found");
  });

  it("fails when a requested scraper key is missing from configured API keys", async () => {
    const result = await runScraper({
      SCRAPER_API_KEYS_JSON: JSON.stringify({ unrelated: "test-key" }),
      SCRAPER_IDS: "flex_at",
      JOBS_API_SERVER: "http://localhost:3000",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Missing scraper API key(s) for: flex_at");
  });
});
