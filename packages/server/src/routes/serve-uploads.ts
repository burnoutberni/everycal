/**
 * Serve uploaded images with on-the-fly re-encoding.
 * Re-encodes every image when served to strip metadata, compress, and mitigate image bombs.
 */

import { Hono } from "hono";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, extname, basename, relative, isAbsolute, sep } from "node:path";
import sharp from "sharp";
import { UPLOAD_DIR } from "../lib/paths.js";

const MAX_DIMENSION = 2048; // Cap to prevent image bombs

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);

export function serveUploadsRoutes({ uploadDir = UPLOAD_DIR }: { uploadDir?: string } = {}): Hono {
  const router = new Hono();
  const DERIVATIVE_DIR = join(uploadDir, ".derived");

  async function getOrCreateDerivative(filepath: string): Promise<Buffer> {
    await mkdir(DERIVATIVE_DIR, { recursive: true });
    const sourceStat = await stat(filepath);
    const outPath = join(DERIVATIVE_DIR, `${basename(filepath)}.jpg`);
    if (existsSync(outPath)) {
      const outStat = await stat(outPath);
      if (outStat.mtimeMs >= sourceStat.mtimeMs) {
        return readFile(outPath);
      }
    }

    const buffer = await readFile(filepath);
    const processed = await sharp(buffer)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    const tempPath = `${outPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, processed);
    await rename(tempPath, outPath).catch(async () => {
      // Race: another request wrote it first.
      await readFile(outPath);
    });
    return processed;
  }

  router.get("/:filename", async (c) => {
    const filename = c.req.param("filename");
    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return c.notFound();
    }

    const filepath = join(uploadDir, filename);
    const resolved = resolve(filepath);
    const uploadDirResolved = resolve(uploadDir);
    const rel = relative(uploadDirResolved, resolved);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return c.notFound();
    }

    if (!existsSync(filepath)) {
      return c.notFound();
    }

    try {
      const processed = await getOrCreateDerivative(filepath);

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
