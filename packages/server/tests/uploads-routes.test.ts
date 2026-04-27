import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { initDatabase, type DB } from "../src/db.js";
import { authRoutes } from "../src/routes/auth.js";
import { uploadRoutes } from "../src/routes/uploads.js";
import { serveUploadsRoutes } from "../src/routes/serve-uploads.js";

function makeApp(db: DB, uploadDir: string, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("/api/v1/uploads*", bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json({ error: "too large" }, 413) }));
  const defaultApiBodyLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "too large" }, 413) });
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/v1/uploads")) {
      await next();
      return;
    }
    return defaultApiBodyLimit(c, next);
  });
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/api/v1/auth", authRoutes(db));
  app.route("/api/v1/uploads", uploadRoutes({ uploadDir }));
  app.route("/uploads", serveUploadsRoutes({ uploadDir }));
  return app;
}

describe("uploads routes", () => {
  let db: DB;
  let uploadDir: string;
  let maliciousSiblingDir: string | null;

  beforeEach(() => {
    process.env.OPEN_REGISTRATIONS = "true";
    db = initDatabase(":memory:");
    uploadDir = mkdtempSync(join(tmpdir(), "everycal-uploads-test-"));
    maliciousSiblingDir = null;
  });

  afterEach(() => {
    rmSync(uploadDir, { recursive: true, force: true });
    if (maliciousSiblingDir) {
      rmSync(maliciousSiblingDir, { recursive: true, force: true });
    }
  });

  it("keeps upload source bytes unchanged across repeated reads", async () => {
    const filename = "idempotent-test.png";
    const filePath = join(uploadDir, filename);
    const source = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 120, b: 240, alpha: 1 } } }).png().toBuffer();
    writeFileSync(filePath, source);

    const app = makeApp(db, uploadDir);
    const before = readFileSync(filePath);
    const first = await app.request(`http://localhost/uploads/${filename}`);
    const second = await app.request(`http://localhost/uploads/${filename}`);
    const after = readFileSync(filePath);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("allows uploads above 1MB while keeping 1MB default API limit", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u7", "gina");
    const app = makeApp(db, uploadDir, { id: "u7", username: "gina" });

    const width = 900;
    const height = 900;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
    const image = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(image.length).toBeGreaterThan(1024 * 1024);
    expect(image.length).toBeLessThan(6 * 1024 * 1024);

    const formData = new FormData();
    formData.append("file", new File([image], "big.png", { type: "image/png" }));
    const uploadRes = await app.request("http://localhost/api/v1/uploads", {
      method: "POST",
      body: formData,
    });
    expect(uploadRes.status).toBe(201);

    const tooLargeJson = JSON.stringify({ username: "x", password: "y".repeat(1024 * 1024) });
    const authRes = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: tooLargeJson,
    });
    expect(authRes.status).toBe(413);
  });

  it("blocks traversal into sibling directories sharing upload prefix", async () => {
    maliciousSiblingDir = `${uploadDir}-malicious`;
    mkdirSync(maliciousSiblingDir, { recursive: true });
    writeFileSync(join(maliciousSiblingDir, "evil.png"), await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer());

    const app = makeApp(db, uploadDir);
    const encodedTraversal = encodeURIComponent(`../${basename(maliciousSiblingDir)}/evil.png`);
    const res = await app.request(`http://localhost/uploads/${encodedTraversal}`);

    expect(res.status).toBe(404);
  });
});
