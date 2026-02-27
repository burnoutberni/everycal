/**
 * Crawler user-agent detection for OG tag rendering.
 */

const CRAWLER_PATTERNS = [
  // Major Social
  /twitterbot/i,
  /facebookexternalhit/i,
  /linkedinbot/i,
  /pinterest/i,
  /redditbot/i,
  /snapchat/i,

  // Fediverse
  /mastodon/i,
  /pleroma/i,
  /akkoma/i,
  /misskey/i,
  /calckey/i,
  /sharkey/i,
  /pixelfed/i,
  /peertube/i,
  /friendica/i,
  /hubzilla/i,
  /lemmy/i,
  /gnu\s*social/i,
  /diaspora/i,

  // Messaging
  /discordbot/i,
  /slackbot/i,
  /telegrambot/i,
  /whatsapp/i,
  /signal/i,
  /skypeuripreview/i,
  /line/i,
  /viber/i,

  // Search
  /googlebot/i,
  /bingbot/i,
  /duckduckbot/i,
  /yandex/i,
  /baiduspider/i,
  /applebot/i,

  // Generic fallback (must be last, more permissive)
  /\b(bot|crawler|spider|preview|fetcher|scraper|http|client|reader|parser)\b/i,
];

/**
 * Check if the user-agent string indicates a crawler/bot.
 */
export function isCrawler(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return CRAWLER_PATTERNS.some((pattern) => pattern.test(userAgent));
}
