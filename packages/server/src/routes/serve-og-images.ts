/**
 * Serve generated OG images.
 */

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { OG_DIR } from "../lib/paths.js";

export function serveOgImagesRoutes(): Hono {
  const router = new Hono();

  router.get("/:ogImageUrl", async (c) => {
    const ogImageUrl = c.req.param("ogImageUrl");

    const filename = ogImageUrl.split("?")[0];
    const filepath = join(OG_DIR, filename);
    const resolved = resolve(filepath);
    const ogDirResolved = resolve(OG_DIR);
    if (!resolved.startsWith(ogDirResolved) || resolved === ogDirResolved) {
      return c.notFound();
    }

    if (!existsSync(filepath)) {
      return c.notFound();
    }

    try {
      const buffer = await readFile(filepath);
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.notFound();
    }
  });

  return router;
}
