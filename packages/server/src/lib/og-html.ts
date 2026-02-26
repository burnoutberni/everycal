/**
 * Dynamic OG tag HTML rendering.
 *
 * Reads and caches the web frontend's index.html, then renders versions
 * with dynamic OG meta tags for crawler requests.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Get the directory of this module (packages/server/src/lib/)
const serverLibDir = dirname(fileURLToPath(import.meta.url));
// Go up to packages/server/, then to repo root, then to web/dist
const serverDir = resolve(serverLibDir, "..");
const packagesDir = resolve(serverDir, "..");
const indexHtmlPath = resolve(packagesDir, "web/dist/index.html");

/** OG tag data for rendering */
export interface OgTags {
  title: string;
  description: string;
  image: string;
  url: string;
  type: string;
  twitterCard?: "summary" | "summary_large_image";
}

/** Cached index.html content */
let cachedIndexHtml: string | null = null;

/**
 * Read and cache the index.html from the web dist folder.
 * Must be called at server startup.
 */
export function loadIndexHtml(): string {
  if (cachedIndexHtml) return cachedIndexHtml;

  try {
    cachedIndexHtml = readFileSync(indexHtmlPath, "utf-8");
  } catch (err) {
    console.error("[OG] Failed to load index.html:", err);
    cachedIndexHtml = "";
  }

  return cachedIndexHtml;
}

/**
 * Escape HTML entities to prevent XSS and broken attributes.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Truncate text to a maximum length, adding ellipsis if truncated.
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}

/**
 * Render HTML with dynamic OG tags injected.
 *
 * @param tags - The OG tag data to inject
 * @returns HTML string with dynamic OG tags
 */
export function renderOgHtml(tags: OgTags): string {
  const indexHtml = loadIndexHtml();
  if (!indexHtml) {
    return `<!DOCTYPE html><html><head><title>${escapeHtml(tags.title)}</title></head><body></body></html>`;
  }

  // Prepare escaped, truncated values
  const ogTitle = escapeHtml(truncate(tags.title, 70));
  const ogDescription = escapeHtml(truncate(tags.description, 200));
  const ogImage = escapeHtml(tags.image);
  const ogUrl = escapeHtml(tags.url);
  const ogType = escapeHtml(tags.type);
  const pageTitle = escapeHtml(tags.title);

  // Build new meta tags
  const metaTags = [
    `<meta property="og:title" content="${ogTitle}" />`,
    `<meta property="og:description" content="${ogDescription}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:url" content="${ogUrl}" />`,
    `<meta property="og:type" content="${ogType}" />`,
    `<meta name="twitter:card" content="${tags.twitterCard || "summary_large_image"}" />`,
    `<meta name="twitter:title" content="${ogTitle}" />`,
    `<meta name="twitter:description" content="${ogDescription}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
  ].join("\n    ");

  // Replace the title
  let result = indexHtml.replace(
    /<title>[^<]*<\/title>/i,
    `<title>${pageTitle}</title>`
  );

  // Replace the description meta tag
  result = result.replace(
    /<meta name="description" content="[^"]*"[^/]*\/>/i,
    `<meta name="description" content="${ogDescription}" />`
  );

  // Replace all OG and Twitter meta tags
  // First, remove existing og:title, og:description, og:image, og:url, og:type
  result = result.replace(/<meta property="og:title" content="[^"]*"[^/]*\/>/gi, "");
  result = result.replace(/<meta property="og:description" content="[^"]*"[^/]*\/>/gi, "");
  result = result.replace(/<meta property="og:image" content="[^"]*"[^/]*\/>/gi, "");
  result = result.replace(/<meta property="og:url" content="[^"]*"[^/]*\/>/gi, "");
  result = result.replace(/<meta property="og:type" content="[^"]*"[^/]*\/>/gi, "");

  // Remove existing twitter:card, twitter:title, twitter:description, twitter:image
  result = result.replace(/<meta name="twitter:card" content="[^"]*"[^/]*\/>/gi, "");
  result = result.replace(/<meta name="twitter:title" content="[^"]*"[^/]*\/>/gi, "");
  result = result.replace(/<meta name="twitter:description" content="[^"]*"[^/]*\/>/gi, "");
  result = result.replace(/<meta name="twitter:image" content="[^"]*"[^/]*\/>/gi, "");

  // Insert new meta tags after the last og:image or og:type tag
  // Find the position to insert (after og:type, or after description if no og:type)
  const insertPoint = result.match(/<meta property="og:image" content="[^"]*"[^/]*\/>/i);
  if (insertPoint) {
    const insertIndex = result.indexOf(insertPoint[0]) + insertPoint[0].length;
    result = result.slice(0, insertIndex) + "\n    " + metaTags + result.slice(insertIndex);
  } else {
    // Fallback: insert after the description meta tag
    const descMatch = result.match(/<meta name="description" content="[^"]*"[^/]*\/>/i);
    if (descMatch) {
      const insertIndex = result.indexOf(descMatch[0]) + descMatch[0].length;
      result = result.slice(0, insertIndex) + "\n    " + metaTags + result.slice(insertIndex);
    } else {
      // Last resort: insert after <head>
      const headMatch = result.match(/<head>/i);
      if (headMatch) {
        const insertIndex = result.indexOf(headMatch[0]) + headMatch[0].length;
        result = result.slice(0, insertIndex) + "\n    " + metaTags + result.slice(insertIndex);
      }
    }
  }

  return result;
}
