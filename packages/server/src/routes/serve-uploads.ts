/**
 * Serve uploaded images with on-the-fly re-encoding.
 * Re-encodes every image when served to strip metadata, compress, and mitigate image bombs.
 */

import { Hono } from "hono";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, extname, basename, relative, isAbsolute, sep } from "node:path";
import sharp from "sharp";
import { UPLOAD_DIR } from "../lib/paths.js";

const MAX_DIMENSION = 2048; // Cap to prevent image bombs

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);

function isENOENT(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isAtomicReplaceRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return ["EEXIST", "EPERM", "EACCES", "ENOTEMPTY"].includes(String(error.code));
}

async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isENOENT(error)) {
      return null;
    }
    throw error;
  }
}

async function cleanupTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isENOENT(error)) {
      throw error;
    }
  }
}

export function serveUploadsRoutes({ uploadDir = UPLOAD_DIR }: { uploadDir?: string } = {}): Hono {
  const router = new Hono();
  const DERIVATIVE_DIR = join(uploadDir, ".derived");

  async function getOrCreateDerivative(filepath: string): Promise<Buffer> {
    await mkdir(DERIVATIVE_DIR, { recursive: true });
    const sourceStat = await stat(filepath);
    const outPath = join(DERIVATIVE_DIR, `${basename(filepath)}.jpg`);

    try {
      const outStat = await stat(outPath);
      if (outStat.mtimeMs >= sourceStat.mtimeMs) {
        try {
          return await readFile(outPath);
        } catch (error) {
          if (!isENOENT(error)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (!isENOENT(error)) {
        throw error;
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
    try {
      await rename(tempPath, outPath);
      return processed;
    } catch (renameError) {
      const winner = await readFileIfExists(outPath);
      if (winner) {
        await cleanupTempFile(tempPath);
        return winner;
      }
      if (isAtomicReplaceRetryable(renameError)) {
        try {
          await cleanupTempFile(outPath);
        } catch {
          // Keep original rename error if replacement cannot proceed.
        }
        try {
          await rename(tempPath, outPath);
          return processed;
        } catch (retryError) {
          const retryWinner = await readFileIfExists(outPath);
          if (retryWinner) {
            await cleanupTempFile(tempPath);
            return retryWinner;
          }
          await cleanupTempFile(tempPath);
          throw retryError;
        }
      }
      await cleanupTempFile(tempPath);
      throw renameError;
    }
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
