/**
 * Upload routes — image upload for events and avatars.
 *
 * POST /api/v1/uploads — upload a file, returns URL
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { getLocale, t } from "../lib/i18n.js";
import { nanoid } from "nanoid";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

/** Allowed image extensions and their MIME types. */
const ALLOWED_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

export function uploadRoutes(): Hono {
  const router = new Hono();

  router.post("/", requireAuth(), async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];

    if (!file || typeof file === "string") {
      return c.json({ error: t(getLocale(c), "uploads.no_file_uploaded") }, 400);
    }

    const blob = file as File;

    if (blob.size > MAX_SIZE) {
      return c.json({ error: t(getLocale(c), "uploads.file_too_large", { max: String(MAX_SIZE / 1024 / 1024) }) }, 400);
    }

    // Validate file extension against allowlist
    const ext = extname(blob.name).toLowerCase();
    const allowedMime = ALLOWED_EXTENSIONS[ext];
    if (!allowedMime) {
      return c.json(
        { error: t(getLocale(c), "uploads.file_type_not_allowed", { accepted: Object.keys(ALLOWED_EXTENSIONS).join(", ") }) },
        400
      );
    }

    // Validate MIME type matches extension
    const mimeType = blob.type || allowedMime;
    if (!mimeType.startsWith("image/")) {
      return c.json({ error: t(getLocale(c), "uploads.only_images_allowed") }, 400);
    }

    // Read the first bytes to verify it's actually an image (magic bytes check)
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (!isImageBuffer(buffer)) {
      return c.json({ error: t(getLocale(c), "uploads.invalid_image") }, 400);
    }

    // Create upload directory
    if (!existsSync(UPLOAD_DIR)) {
      mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    // Always use the validated extension, never trust the original filename
    const filename = `${nanoid(16)}${ext}`;
    const filepath = join(UPLOAD_DIR, filename);

    // Defense-in-depth: verify resolved path stays within upload directory
    const resolvedPath = resolve(filepath);
    if (!resolvedPath.startsWith(resolve(UPLOAD_DIR))) {
      return c.json({ error: t(getLocale(c), "uploads.invalid_path") }, 400);
    }

    writeFileSync(filepath, buffer);

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const url = `${baseUrl}/uploads/${filename}`;

    return c.json({ url, mediaType: allowedMime, filename }, 201);
  });

  return router;
}

/** Check magic bytes to verify the buffer is actually an image. */
function isImageBuffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;

  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;

  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;

  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;

  // AVIF: ... 66 74 79 70 61 76 69 66 (ftyp avif) — usually at offset 4
  if (buf.length >= 12) {
    const ftypIdx = buf.indexOf(Buffer.from("ftypavif"));
    if (ftypIdx >= 0 && ftypIdx < 32) return true;
    const ftypMif1 = buf.indexOf(Buffer.from("ftypmif1"));
    if (ftypMif1 >= 0 && ftypMif1 < 32) return true;
  }

  return false;
}
