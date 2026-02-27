/**
 * OG tag HTML renderer - reads and modifies the SPA index.html for crawler requests.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "..");
const WEB_DIST_PATH = resolve(repoRoot, "packages/web/dist/index.html");

let cachedHtml: string | null = null;

/**
 * Read and cache the web SPA index.html.
 */
async function getIndexHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  cachedHtml = await readFile(WEB_DIST_PATH, "utf-8");
  return cachedHtml;
}

/**
 * OG tags to inject into the HTML.
 */
export interface OgTags {
  title: string;
  description: string;
  image: string;
  url: string;
  type?: string;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Truncate text to a maximum length, adding ellipsis if truncated.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3).trim() + "...";
}

const MAX_TITLE_LENGTH = 70;
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Render HTML with OG tags injected.
 * Reads the cached index.html and replaces the relevant meta tags.
 */
export async function renderOgHtml(tags: OgTags): Promise<string> {
  const html = await getIndexHtml();

  const title = truncate(escapeHtml(tags.title), MAX_TITLE_LENGTH);
  const description = truncate(escapeHtml(tags.description), MAX_DESCRIPTION_LENGTH);
  const image = escapeHtml(tags.image);
  const url = escapeHtml(tags.url);
  const type = tags.type || "website";

  let result = html;

  // Replace <title>
  result = result.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);

  // Replace og:title
  result = result.replace(
    /<meta\s+property=["']og:title["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta property="og:title" content="${title}" />`
  );

  // Replace twitter:title
  result = result.replace(
    /<meta\s+name=["']twitter:title["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta name="twitter:title" content="${title}" />`
  );

  // Replace og:description
  result = result.replace(
    /<meta\s+property=["']og:description["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta property="og:description" content="${description}" />`
  );

  // Replace twitter:description
  result = result.replace(
    /<meta\s+name=["']twitter:description["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta name="twitter:description" content="${description}" />`
  );

  // Replace og:image
  result = result.replace(
    /<meta\s+property=["']og:image["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta property="og:image" content="${image}" />`
  );

  // Replace twitter:image
  result = result.replace(
    /<meta\s+name=["']twitter:image["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta name="twitter:image" content="${image}" />`
  );

  // Replace og:url
  result = result.replace(
    /<meta\s+property=["']og:url["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta property="og:url" content="${url}" />`
  );

  // Replace og:type
  result = result.replace(
    /<meta\s+property=["']og:type["']\s+content=["'][^"']*["']\s*\/>/i,
    `<meta property="og:type" content="${type}" />`
  );

  return result;
}
