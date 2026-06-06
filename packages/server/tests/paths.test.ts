import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";

describe("path helpers", () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousUploadDir = process.env.UPLOAD_DIR;
  const previousOgDir = process.env.OG_DIR;

  afterEach(() => {
    vi.resetModules();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousUploadDir === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = previousUploadDir;
    }
    if (previousOgDir === undefined) {
      delete process.env.OG_DIR;
    } else {
      process.env.OG_DIR = previousOgDir;
    }
  });

  it("reads DATABASE_PATH lazily after module import", async () => {
    delete process.env.DATABASE_PATH;
    const { getDatabasePath } = await import("../src/lib/paths.js");

    process.env.DATABASE_PATH = "/tmp/everycal-runtime.db";

    expect(getDatabasePath()).toBe("/tmp/everycal-runtime.db");
  });

  it("falls back to repo defaults when env vars are absent", async () => {
    delete process.env.DATABASE_PATH;
    delete process.env.UPLOAD_DIR;
    delete process.env.OG_DIR;
    const { getDatabasePath, getUploadDir, getOgDir } = await import("../src/lib/paths.js");

    expect(getDatabasePath()).toBe(resolve(process.cwd(), "../..", "everycal.db"));
    expect(getUploadDir()).toBe(resolve(process.cwd(), "../..", "uploads"));
    expect(getOgDir()).toBe(resolve(process.cwd(), "../..", "og-images"));
  });

  it("resolves route defaults from env at call time", async () => {
    delete process.env.UPLOAD_DIR;
    const { serveUploadsRoutes } = await import("../src/routes/serve-uploads.js");

    const uploadDir = mkdtempSync(resolve(tmpdir(), "everycal-uploads-"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=", "base64");
    writeFileSync(resolve(uploadDir, "ok.png"), png);

    try {
      process.env.UPLOAD_DIR = uploadDir;
      const app = new Hono();
      app.route("/uploads", serveUploadsRoutes());

      const res = await app.request("http://localhost/uploads/ok.png");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
    } finally {
      rmSync(uploadDir, { recursive: true, force: true });
    }
  });
});
