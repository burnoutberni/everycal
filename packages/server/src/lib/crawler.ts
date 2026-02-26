/**
 * Crawler user-agent detection.
 *
 * Detects social media crawlers, fediverse bots, search engines, and other
 * automated clients that need server-rendered OG tags.
 */

/**
 * Comprehensive list of crawler user-agent patterns.
 * Sorted by category for maintainability.
 */
const CRAWLER_PATTERNS = [
  // Major Social Media / Messaging
  "Twitterbot",
  "facebookexternalhit",
  "Facebot",
  "LinkedInBot",
  "Pinterest",
  "Slackbot",
  "Discordbot",
  "TelegramBot",
  "WhatsApp",
  "Signal",
  "Skype",
  "LINE",
  "Viber",

  // ActivityPub / Fediverse
  "Mastodon",
  "Pleroma",
  "Akkoma",
  "Misskey",
  "Calckey",
  "Sharkey",
  "Pixelfed",
  "PeerTube",
  "Friendica",
  "Hubzilla",
  "Lemmy",
  "GNU Social",
  "Diaspora",

  // Apple
  "Applebot",

  // Search Engines
  "Googlebot",
  "Google-InspectionTool",
  "GoogleOther",
  "Bingbot",
  "BingPreview",
  "DuckDuckBot",
  "Yandex",
  "Baiduspider",
  "Sogou",
  "Exabot",
  "MJ12bot",

  // Generic patterns (case-insensitive)
  "bot",
  "crawler",
  "spider",
  "preview",
  "fetcher",
  "scraper",
  "http client",
];

/**
 * Check if a user-agent string matches any known crawler pattern.
 *
 * @param userAgent - The User-Agent header value (undefined if not provided)
 * @returns true if the user-agent appears to be a crawler
 */
export function isCrawler(userAgent: string | undefined): boolean {
  if (!userAgent) return false;

  const ua = userAgent.toLowerCase();

  // Check specific patterns first
  for (const pattern of CRAWLER_PATTERNS) {
    if (ua.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  return false;
}
