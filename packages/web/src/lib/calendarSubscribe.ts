export type CalendarApp = "apple" | "local" | "google" | "outlook";

export function getCalendarOrder(): CalendarApp[] {
  const ua = navigator.userAgent.toLowerCase();
  const isMac = /mac|macintosh/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);

  if (isMac || isIOS) return ["apple", "google", "outlook"];
  if (isAndroid) return ["google", "outlook"];
  return ["local", "google", "outlook"];
}

export function buildCalendarUrls(feedUrl: string | null) {
  if (!feedUrl) return null;
  return {
    webcal: feedUrl.replace(/^https?:\/\//, "webcal://"),
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedUrl)}`,
    outlook: `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(feedUrl)}`,
  };
}
