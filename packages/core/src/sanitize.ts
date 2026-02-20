/**
 * Shared HTML sanitization configuration.
 * Used by both server (sanitize-html) and client (DOMPurify) to enforce
 * the same set of allowed tags and attributes across the codebase.
 */

export const SAFE_HTML_TAGS = [
  "p", "br", "b", "i", "em", "strong", "u",
  "a",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "code", "pre",
  "hr",
  "span", "div",
] as const;

export const SAFE_HTML_ATTRS: Record<string, string[]> = {
  a: ["href", "rel", "target"],
};

/** Flat list of attribute names (for DOMPurify's ALLOWED_ATTR). */
export const SAFE_HTML_ATTR_LIST = ["href", "rel", "target"];

/** Allowed URI schemes for href attributes. */
export const SAFE_HTML_SCHEMES = ["http", "https", "mailto"];
