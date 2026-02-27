/**
 * Vike SSR integration for Hono.
 *
 * This module provides helpers to render pages using Vike's SSR capabilities
 * within the Hono server.
 */

import { renderPage } from "vike/server";
import type { Context } from "hono";
import { getLocale } from "./lib/i18n.js";

export interface SsrResult {
  statusCode: number;
  body: string;
}

/**
 * Check if a URL should be rendered via SSR.
 * Only /@username and /@username/:slug routes use SSR.
 */
export function isSsrRoute(url: string): boolean {
  // Match /@username or /@username/slug patterns
  const ssrPattern = /^\/@[^/]+(\/[^/]+)?\/?$/;
  return ssrPattern.test(url.split("?")[0]);
}

/**
 * Parse URL for route params
 */
function parseUrl(url: string): { pathname: string; search: Record<string, string | undefined> } {
  const [pathname, queryString] = url.split("?");
  const search: Record<string, string | undefined> = {};
  
  if (queryString) {
    for (const pair of queryString.split("&")) {
      const [key, value] = pair.split("=");
      if (key) {
        search[key] = value ? decodeURIComponent(value) : undefined;
      }
    }
  }
  
  // Also parse route params from pathname
  const profileMatch = pathname.match(/^\/@([^/]+)\/?$/);
  const eventMatch = pathname.match(/^\/@([^/]+)\/([^/]+)\/?$/);
  
  if (eventMatch) {
    search.username = eventMatch[1];
    search.slug = eventMatch[2];
  } else if (profileMatch) {
    search.username = profileMatch[1];
  }
  
  return { pathname, search };
}

/**
 * Render a page using Vike SSR.
 */
export async function renderSsrPage(
  c: Context,
  urlOriginal: string
): Promise<SsrResult> {
  const user = c.get("user");
  const locale = getLocale(c);
  const urlParsed = parseUrl(urlOriginal);

  const pageContextInit = {
    urlOriginal,
    urlParsed,
    locale,
    user: user
      ? {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          preferredLanguage: user.preferredLanguage,
        }
      : null,
  };

  const pageContext = await renderPage(pageContextInit);
  const { httpResponse } = pageContext;

  if (!httpResponse) {
    return {
      statusCode: 500,
      body: "SSR rendering failed",
    };
  }

  const { statusCode, body } = httpResponse;

  return {
    statusCode,
    body: typeof body === "string" ? body : body.toString(),
  };
}
