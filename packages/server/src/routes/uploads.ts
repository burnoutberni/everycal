/**
 * Upload routes — image upload for events and avatars.
 *
 * POST /api/v1/uploads — upload a file, returns URL
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { nanoid } from "nanoid";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { lookup } from "mime-types";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export function uploadRoutes(): Hono {
  const router = new Hono();

  router.post("/", requireAuth(), async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];

    if (!file || typeof file === "string") {
      return c.json({ error: "No file uploaded. Send as multipart with field name 'file'." }, 400);
    }

    const blob = file as File;

    if (blob.size > MAX_SIZE) {
      return c.json({ error: `File too large. Maximum is ${MAX_SIZE / 1024 / 1024}MB.` }, 400);
    }

    const mimeType = blob.type || lookup(blob.name) || "application/octet-stream";
    if (!mimeType.startsWith("image/")) {
      return c.json({ error: "Only image files are allowed." }, 400);
    }

    // Create upload directory
    if (!existsSync(UPLOAD_DIR)) {
      mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    const ext = extname(blob.name) || ".jpg";
    const filename = `${nanoid(16)}${ext}`;
    const filepath = join(UPLOAD_DIR, filename);

    const buffer = Buffer.from(await blob.arrayBuffer());
    writeFileSync(filepath, buffer);

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const url = `${baseUrl}/uploads/${filename}`;

    return c.json({ url, mediaType: mimeType, filename }, 201);
  });

  return router;
}
