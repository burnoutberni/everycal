import he from "he";

/** Decode HTML entities exactly once (e.g. &amp; -> &, &amp;amp; -> &amp;). */
export function decodeHtmlEntitiesOnce(text: string): string {
  return he.decode(text);
}
