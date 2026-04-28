import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

async function makeApp(ogDir: string): Promise<Hono> {
  const previousOgDir = process.env.OG_DIR;
  process.env.OG_DIR = ogDir;
  vi.resetModules();
  const { serveOgImagesRoutes } = await import("../src/routes/serve-og-images.js");
  if (previousOgDir === undefined) {
    delete process.env.OG_DIR;
  } else {
    process.env.OG_DIR = previousOgDir;
  }

  const app = new Hono();
  app.route("/og-images", serveOgImagesRoutes());
  return app;
}

describe("serveOgImagesRoutes", () => {
  let ogDir: string;
  let maliciousSiblingDir: string | null;

  beforeEach(() => {
    ogDir = mkdtempSync(join(tmpdir(), "everycal-og-test-"));
    maliciousSiblingDir = null;
  });

  afterEach(() => {
    rmSync(ogDir, { recursive: true, force: true });
    if (maliciousSiblingDir) {
      rmSync(maliciousSiblingDir, { recursive: true, force: true });
    }
  });

  it("serves in-directory OG image files", async () => {
    writeFileSync(join(ogDir, "ok.png"), Buffer.from("png-data"));
    const app = await makeApp(ogDir);

    const res = await app.request("http://localhost/og-images/ok.png");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png-data");
  });

  it("blocks traversal into sibling directories sharing OG prefix", async () => {
    maliciousSiblingDir = `${ogDir}-malicious`;
    mkdirSync(maliciousSiblingDir, { recursive: true });
    writeFileSync(join(maliciousSiblingDir, "evil.png"), Buffer.from("not-allowed"));
    const app = await makeApp(ogDir);

    const encodedTraversal = encodeURIComponent(`../${basename(maliciousSiblingDir)}/evil.png`);
    const res = await app.request(`http://localhost/og-images/${encodedTraversal}`);

    expect(res.status).toBe(404);
  });
});
