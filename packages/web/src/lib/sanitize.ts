/**
 * Centralized HTML sanitization for the web app.
 * Uses DOMPurify with @everycal/core config (matches server's sanitize-html).
 *
 * - sanitizeHtml: rich HTML (descriptions, bios) — allows safe tags
 * - sanitizeHtmlWithNewlines: same + converts \n to <br> (for plain-text-like content)
 * - escapeHtml: escape text for safe insertion into HTML (prevents XSS in templates)
 * - stripHtmlToText: remove all HTML for plain-text display (tooltips, truncation)
 */

import DOMPurify from "dompurify";
import { SAFE_HTML_TAGS, SAFE_HTML_ATTR_LIST } from "@everycal/core";

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...SAFE_HTML_TAGS],
    ALLOWED_ATTR: [...SAFE_HTML_ATTR_LIST],
  });
}

/** Sanitize HTML, converting newlines to <br> for display (bios, summaries, plain-text descriptions). */
export function sanitizeHtmlWithNewlines(html: string): string {
  return sanitizeHtml(html.replace(/\n/g, "<br>"));
}

/** Escape text for safe insertion into HTML (e.g. in template literals). Prevents XSS. */
export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** Strip all HTML tags to produce plain text. Safe for tooltips, truncation, search. */
export function stripHtmlToText(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
