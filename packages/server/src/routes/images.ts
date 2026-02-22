/**
 * Image search routes — proxy for Unsplash and Openverse APIs.
 *
 * GET /api/v1/images/sources — list available sources
 * GET /api/v1/images/search?q=QUERY&source= — search for header images (returns url + attribution)
 * POST /api/v1/images/trigger-download — trigger Unsplash download tracking (per API guidelines)
 */

import { Hono } from "hono";
import { getLocale, t } from "../lib/i18n.js";

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const OPENVERSE_BASE = "https://api.openverse.org/v1";
const UTM_SOURCE = "everycal";
const UTM_MEDIUM = "referral";

interface UnsplashPhoto {
  urls?: { regular?: string; small?: string; full?: string };
  alt_description?: string;
  description?: string;
  user?: { name?: string; username?: string };
  links?: { download_location?: string; html?: string };
}

interface OpenverseResult {
  url?: string;
  title?: string;
  foreign_landing_url?: string;
  creator?: string;
  creator_url?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  attribution?: string;
}

export interface ImageResult {
  url: string;
  attribution?: {
    source: "unsplash" | "openverse";
    title?: string;
    sourceUrl?: string;
    creator?: string;
    creatorUrl?: string;
    license?: string;
    licenseUrl?: string;
    attribution?: string;
    downloadLocation?: string;
  };
}

export function imageRoutes(): Hono {
  const router = new Hono();

  router.get("/sources", (c) => {
    const sources: string[] = [];
    if (UNSPLASH_ACCESS_KEY) sources.push("unsplash");
    sources.push("openverse");
    return c.json({
      sources,
      unsplashAvailable: !!UNSPLASH_ACCESS_KEY,
    });
  });

  /** Trigger Unsplash download tracking when user selects an image (per API guidelines). */
  router.post("/trigger-download", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { downloadLocation?: string };
    const url = body?.downloadLocation?.trim();
    if (!url || !UNSPLASH_ACCESS_KEY) {
      return c.json({ error: t(getLocale(c), "common.invalid_request") }, 400);
    }
    try {
      const sep = url.includes("?") ? "&" : "?";
      await fetch(`${url}${sep}client_id=${UNSPLASH_ACCESS_KEY}`);
    } catch {
      // Non-critical; don't fail the request
    }
    return c.json({ ok: true });
  });

  router.get("/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 2) {
      return c.json({ error: t(getLocale(c), "images.query_required") }, 400);
    }
    const limit = Math.min(30, Math.max(1, parseInt(c.req.query("limit") || "12", 10)));
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const source = (c.req.query("source") || "auto").toLowerCase();

    const tryUnsplash = () =>
      source === "openverse" ? false : !!UNSPLASH_ACCESS_KEY;
    const tryOpenverse = () =>
      source === "unsplash" ? false : true;

    // Try Unsplash if requested and key is configured
    if (tryUnsplash()) {
      try {
        const params = new URLSearchParams({
          query: q,
          per_page: String(limit),
          page: String(page),
          orientation: "landscape",
        });
        const res = await fetch(
          `https://api.unsplash.com/search/photos?${params}`,
          {
            headers: {
              Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
              "Accept-Version": "v1",
            },
          }
        );
        if (res.ok) {
          const data = (await res.json()) as { results?: UnsplashPhoto[] };
          const results: ImageResult[] = [];
          for (const p of data.results || []) {
            const url = p?.urls?.regular || p?.urls?.small || p?.urls?.full;
            if (!url) continue;
            const username = p?.user?.username;
            const creatorUrl = username
              ? `https://unsplash.com/@${username}?utm_source=${UTM_SOURCE}&utm_medium=${UTM_MEDIUM}`
              : undefined;
            const unsplashTitle = p?.alt_description || p?.description || "Photo";
            results.push({
              url,
              attribution: {
                source: "unsplash",
                title: unsplashTitle,
                sourceUrl: p?.links?.html ? `${p.links.html}?utm_source=${UTM_SOURCE}&utm_medium=${UTM_MEDIUM}` : undefined,
                creator: p?.user?.name,
                creatorUrl,
                license: "unsplash",
                licenseUrl: "https://unsplash.com/license",
                downloadLocation: p?.links?.download_location,
              },
            });
          }
          if (results.length > 0) {
            return c.json({ results, source: "unsplash" });
          }
        }
      } catch {
        // Fall through to Openverse when source=auto
      }
    }

    // Openverse — allow all licenses (no license filter)
    if (tryOpenverse()) {
      try {
        const params = new URLSearchParams({
          q,
          page_size: String(limit),
          page: String(page),
        });
        const res = await fetch(`${OPENVERSE_BASE}/images/?${params}`);
        if (res.ok) {
          const data = (await res.json()) as { results?: OpenverseResult[] };
          const results: ImageResult[] = [];
          for (const r of data.results || []) {
            if (!r?.url) continue;
            results.push({
              url: r.url,
              attribution: {
                source: "openverse",
                title: r.title || "Image",
                sourceUrl: r.foreign_landing_url,
                creator: r.creator,
                creatorUrl: r.creator_url,
                license: r.license,
                licenseUrl: r.license_url,
                attribution: r.attribution,
              },
            });
          }
          if (results.length > 0) {
            return c.json({ results, source: "openverse" });
          }
        }
      } catch {
        // Ignore
      }
    }

    return c.json({ error: t(getLocale(c), "images.no_images_found") }, 404);
  });

  return router;
}
