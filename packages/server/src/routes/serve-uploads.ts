/**
 * Serve uploaded images with on-the-fly re-encoding.
 * Re-encodes every image when served to strip metadata, compress, and mitigate image bombs.
 */

import { Hono } from "hono";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import sharp from "sharp";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const MAX_DIMENSION = 2048; // Cap to prevent image bombs

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);

export function serveUploadsRoutes(): Hono {
  const router = new Hono();

  router.get("/:filename", async (c) => {
    const filename = c.req.param("filename");
    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return c.notFound();
    }

    const filepath = join(UPLOAD_DIR, filename);
    const resolved = resolve(filepath);
    const uploadDirResolved = resolve(UPLOAD_DIR);
    if (!resolved.startsWith(uploadDirResolved) || resolved === uploadDirResolved) {
      return c.notFound();
    }

    if (!existsSync(filepath)) {
      return c.notFound();
    }

    try {
      const buffer = await readFile(filepath);

      const processed = await sharp(buffer)
        .rotate() // Strip EXIF orientation, auto-rotate
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: { r: 255, g: 255, b: 255 } }) // Flatten transparency to white
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();

      // Replace original with converted JPEG (drop original)
      await writeFile(filepath, processed);

      return new Response(new Uint8Array(processed), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.notFound();
    }
  });

  return router;
}
