import * as cheerio from "cheerio";

/** Decode HTML entities exactly once (e.g. &amp; -> &, &amp;amp; -> &amp;). */
export function decodeHtmlEntitiesOnce(text: string): string {
  return cheerio.load(`<p>${text}</p>`)("p").text();
}
