/**
 * Simple SSR without vike - uses React's renderToString directly.
 * Renders /@username and /@username/:slug routes server-side with OG tags.
 */

import { Hono } from "hono";
import { renderToString } from "react-dom/server";
import React from "react";
import { getLocale } from "../lib/i18n.js";
import type { DB } from "../db.js";

// JSON translation strings (minimal for SSR)
const i18nStrings = {
  en: {
    common: { loading: "Loading...", 404: "Not Found", pageNotFound: "The page you requested could not be found." },
    profile: { userNotFound: "User not found", noEventsFound: "No events found", noUpcomingFromAccount: "No upcoming events from this account" },
    events: { eventNotFound: "Event not found" },
  },
  de: {
    common: { loading: "Laden...", 404: "Nicht gefunden", pageNotFound: "Die angeforderte Seite konnte nicht gefunden werden." },
    profile: { userNotFound: "Benutzer nicht gefunden", noEventsFound: "Keine Veranstaltungen", noUpcomingFromAccount: "Keine anstehenden Veranstaltungen von diesem Konto" },
    events: { eventNotFound: "Veranstaltung nicht gefunden" },
  },
};

function t(locale: string, key: string): string {
  const parts = key.split(":");
  const ns = parts[0] || "common";
  const k = parts[1] || key;
  return (i18nStrings as any)[locale]?.[ns]?.[k] || (i18nStrings as any).en?.[ns]?.[k] || key;
}

export function ssrRoutes(db: DB): Hono {
  const router = new Hono();

  // SSR route handler - catches /@username 
  router.get("/@:username", async (c) => {
    if (c.req.method !== "GET") {
      return c.text("Method not allowed", 405);
    }
    
    const username = c.req.param("username");
    
    if (username.includes("/")) {
      return c.text("Not found", 404);
    }
    
    const locale = getLocale(c);
    const baseUrl = getBaseUrl(c);
    
    try {
      const profileData = await fetchProfileData(username, baseUrl, c.req.header("Cookie"));
      
      if (!profileData.profile) {
        return c.text("Not found", 404);
      }
      
      const html = renderProfilePage(profileData, username, locale, baseUrl);
      
      return c.html(html, 200, {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=60, s-maxage=60",
      });
    } catch (error) {
      console.error("SSR error for /@username:", error);
      return c.text("Internal server error", 500);
    }
  });

  // Event page SSR - /@username/:slug
  router.get("/@:username/:slug", async (c) => {
    if (c.req.method !== "GET") {
      return c.text("Method not allowed", 405);
    }
    
    const username = c.req.param("username");
    const slug = c.req.param("slug");
    
    const locale = getLocale(c);
    const baseUrl = getBaseUrl(c);
    
    try {
      const eventData = await fetchEventData(username, slug, baseUrl, c.req.header("Cookie"));
      
      if (!eventData.event) {
        return c.text("Not found", 404);
      }
      
      const html = renderEventPage(eventData, username, slug, locale, baseUrl);
      
      return c.html(html, 200, {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=60, s-maxage=60",
      });
    } catch (error) {
      console.error("SSR error for /@username/:slug:", error);
      return c.text("Internal server error", 500);
    }
  });

  return router;
}

function getBaseUrl(c: any): string {
  const protocol = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("host") || "localhost:3000";
  return `${protocol}://${host}`;
}

async function fetchProfileData(username: string, baseUrl: string, cookie: string | undefined) {
  try {
    const profileRes = await fetch(`${baseUrl}/api/v1/users/${encodeURIComponent(username)}`, {
      headers: cookie ? { Cookie: cookie } : {},
      credentials: "include",
    });
    
    if (!profileRes.ok) {
      return { profile: null, events: [], calendarEventDates: [] };
    }
    
    const profile = await profileRes.json();
    
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const firstVisible = new Date(now.getFullYear(), now.getMonth(), 1 - startOffset);
    const endOffset = (7 - lastOfMonth.getDay()) % 7;
    const lastVisible = new Date(now.getFullYear(), now.getMonth() + 1, 0 + endOffset);
    
    const formatDate = (d: Date) => d.toISOString().split("T")[0];
    
    const eventsRes = await fetch(
      `${baseUrl}/api/v1/users/${encodeURIComponent(username)}/events?from=${formatDate(firstVisible)}&to=${formatDate(lastVisible)}&limit=500`,
      { headers: cookie ? { Cookie: cookie } : {}, credentials: "include" }
    );
    
    let calendarEventDates: string[] = [];
    if (eventsRes.ok) {
      const eventsData = await eventsRes.json();
      calendarEventDates = eventsData.events?.map((e: any) => e.startDate.split("T")[0]) || [];
    }
    
    const upcomingRes = await fetch(
      `${baseUrl}/api/v1/users/${encodeURIComponent(username)}/events?from=${now.toISOString()}&limit=100&sort=asc`,
      { headers: cookie ? { Cookie: cookie } : {}, credentials: "include" }
    );
    
    let events: any[] = [];
    if (upcomingRes.ok) {
      const upcomingData = await upcomingRes.json();
      events = upcomingData.events || [];
    }
    
    return { profile, events, calendarEventDates };
  } catch (error) {
    console.error("Error fetching profile data:", error);
    return { profile: null, events: [], calendarEventDates: [] };
  }
}

async function fetchEventData(username: string, slug: string, baseUrl: string, cookie: string | undefined) {
  try {
    const eventRes = await fetch(
      `${baseUrl}/api/v1/events/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`,
      { headers: cookie ? { Cookie: cookie } : {}, credentials: "include" }
    );
    
    if (!eventRes.ok) {
      return { event: null, error: eventRes.status === 404 ? "Event not found" : "Failed to load event" };
    }
    
    const event = await eventRes.json();
    return { event };
  } catch (error) {
    console.error("Error fetching event data:", error);
    return { event: null, error: "Failed to load event" };
  }
}

function generateProfileOgTags(profile: any, locale: string) {
  const title = `${profile.displayName || profile.username} (@${profile.username}) — EveryCal`;
  const description = profile.bio 
    ? profile.bio 
    : `Events from ${profile.displayName || profile.username} on EveryCal`;
  
  return { title, description, ogImage: profile.avatarUrl };
}

function formatEventDateTime(dateStr: string, allDay: boolean, locale: string): string {
  const d = new Date(dateStr);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  };
  if (!allDay) {
    opts.hour = "numeric";
    opts.minute = "2-digit";
  }
  return d.toLocaleString(locale === "de" ? "de-AT" : "en", opts);
}

function generateEventOgTags(event: any, locale: string, baseUrl: string) {
  const dateTimeStr = event.endDate
    ? `${formatEventDateTime(event.startDate, event.allDay, locale)} – ${formatEventDateTime(event.endDate, event.allDay, locale)}`
    : formatEventDateTime(event.startDate, event.allDay, locale);
  
  const title = `${event.title} — EveryCal`;
  const description = event.location?.name
    ? `${dateTimeStr} • ${event.location.name}`
    : dateTimeStr;
  
  const ogImage = event.ogImageUrl
    ? `${baseUrl}${event.ogImageUrl}`
    : event.image?.url
      ? `${baseUrl}${event.image.url}`
      : undefined;
  
  return { title, description, ogImage };
}

function renderProfilePage(data: any, username: string, locale: string, baseUrl: string): string {
  const { profile, events, calendarEventDates } = data;
  const ogTags = generateProfileOgTags(profile, locale);
  
  // Group events by date
  const groupedEvents = groupEventsByDate(events);
  
  const eventsHtml = events.length === 0
    ? `<div class="empty-state"><p>${t(locale, "profile:noEventsFound")}</p><p class="text-sm text-dim mt-1">${t(locale, "profile:noUpcomingFromAccount")}</p></div>`
    : [...groupedEvents.entries()].map(([dateKey, dayEvents]) => `
        <div class="profile-date-section" style="margin-bottom: 1.25rem">
          <h2 class="text-sm" style="font-weight: 600; color: var(--text-muted); margin-bottom: 0.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem;">
            ${formatDateHeading(dateKey, locale)}
          </h2>
          <div class="flex flex-col gap-1">
            ${dayEvents.map((e: any) => `
              <div class="event-card">
                <a href="/@${profile.username}/${e.slug}" style="text-decoration: none; color: inherit; display: block;">
                  <div style="font-weight: 600;">${escapeHtml(e.title)}</div>
                  <div class="text-muted text-sm">${formatEventDateTime(e.startDate, e.allDay, locale)}</div>
                  ${e.location ? `<div class="text-muted text-sm">${escapeHtml(e.location.name)}</div>` : ""}
                </a>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("");

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(ogTags.title)}</title>
  <meta name="description" content="${escapeHtml(ogTags.description)}" />
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <meta property="og:title" content="${escapeHtml(ogTags.title)}" />
  <meta property="og:description" content="${escapeHtml(ogTags.description)}" />
  ${ogTags.ogImage ? `<meta property="og:image" content="${escapeHtml(ogTags.ogImage)}" />` : ""}
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(ogTags.title)}" />
  <meta name="twitter:description" content="${escapeHtml(ogTags.description)}" />
  ${ogTags.ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogTags.ogImage)}" />` : ""}
  <script>window.__SSR_DATA__ = ${JSON.stringify({ profile, events, calendarEventDates })};</script>
  <link rel="stylesheet" href="/index.css" />
</head>
<body>
  <div id="root">
    <header class="app-header" style="display: flex; align-items: center; padding: 1rem; border-bottom: 1px solid var(--border);">
      <a href="/" style="text-decoration: none; color: inherit;">
        <div style="font-weight: 700; font-size: 1.25rem;">EveryCal</div>
      </a>
      <nav style="margin-left: auto; display: flex; gap: 1rem;">
        <a href="/" style="text-decoration: none; color: var(--text-muted);">Home</a>
        <a href="/discover" style="text-decoration: none; color: var(--text-muted);">Discover</a>
        <a href="/calendar" style="text-decoration: none; color: var(--text-muted);">Calendar</a>
      </nav>
    </header>
    <main class="container app-main" style="padding: 1.5rem; padding-bottom: 3rem;">
      <div class="flex gap-2" style="align-items: flex-start;">
        <aside class="hide-mobile" style="flex: 0 0 220px; position: sticky; top: 1rem;">
          <div style="border: 1px solid var(--border); border-radius: var(--radius); padding: 0.75rem;">
            <div style="text-align: center; margin-bottom: 1rem;">
              <div class="avatar" style="width: 80px; height: 80px; font-size: 2rem; margin: 0 auto 0.5rem;">
                ${profile.avatarUrl 
                  ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" />`
                  : (profile.displayName || profile.username || "?").charAt(0).toUpperCase()
                }
              </div>
              <div style="font-weight: 600;">${escapeHtml(profile.displayName || profile.username)}</div>
              <div class="text-muted text-sm">@${escapeHtml(profile.username)}</div>
            </div>
            ${profile.bio ? `<p class="text-muted text-sm" style="margin-bottom: 1rem;">${escapeHtml(profile.bio)}</p>` : ""}
            <div class="flex" style="justify-content: center; gap: 1.5rem; font-size: 0.875rem;">
              <div><span style="font-weight: 600;">${profile.followersCount || 0}</span> <span class="text-muted">Followers</span></div>
              <div><span style="font-weight: 600;">${profile.followingCount || 0}</span> <span class="text-muted">Following</span></div>
            </div>
          </div>
        </aside>
        <div class="flex-1" style="min-width: 0;">
          <div style="margin-bottom: 1.5rem;">
            <h1 style="font-size: 1.5rem; font-weight: 700;">${escapeHtml(profile.displayName || profile.username)}</h1>
            <p class="text-muted">@${escapeHtml(profile.username)}</p>
          </div>
          ${eventsHtml}
        </div>
      </div>
    </main>
  </div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`;
}

function renderEventPage(data: any, username: string, slug: string, locale: string, baseUrl: string): string {
  const { event } = data;
  const ogTags = generateEventOgTags(event, locale, baseUrl);
  
  const formatDate = (dateStr: string, allDay: boolean) => formatEventDateTime(dateStr, allDay, locale);
  
  const dateTimeHtml = event.endDate
    ? `${formatDate(event.startDate, event.allDay)} – ${formatDate(event.endDate, event.allDay)}`
    : formatDate(event.startDate, event.allDay);

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(ogTags.title)}</title>
  <meta name="description" content="${escapeHtml(ogTags.description)}" />
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <meta property="og:title" content="${escapeHtml(ogTags.title)}" />
  <meta property="og:description" content="${escapeHtml(ogTags.description)}" />
  ${ogTags.ogImage ? `<meta property="og:image" content="${escapeHtml(ogTags.ogImage)}" />` : ""}
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(ogTags.title)}" />
  <meta name="twitter:description" content="${escapeHtml(ogTags.description)}" />
  ${ogTags.ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogTags.ogImage)}" />` : ""}
  <script>window.__SSR_DATA__ = ${JSON.stringify({ event })};</script>
  <link rel="stylesheet" href="/index.css" />
</head>
<body>
  <div id="root">
    <header class="app-header" style="display: flex; align-items: center; padding: 1rem; border-bottom: 1px solid var(--border);">
      <a href="/" style="text-decoration: none; color: inherit;">
        <div style="font-weight: 700; font-size: 1.25rem;">EveryCal</div>
      </a>
      <nav style="margin-left: auto; display: flex; gap: 1rem;">
        <a href="/" style="text-decoration: none; color: var(--text-muted);">Home</a>
        <a href="/discover" style="text-decoration: none; color: var(--text-muted);">Discover</a>
        <a href="/calendar" style="text-decoration: none; color: var(--text-muted);">Calendar</a>
      </nav>
    </header>
    <main class="container app-main" style="padding: 1.5rem; padding-bottom: 3rem;">
      <article>
        ${event.image ? `
          <div style="margin-bottom: 1.5rem;">
            <img src="${escapeHtml(event.image.url)}" alt="${escapeHtml(event.image.alt || event.title)}" style="width: 100%; max-height: 350px; object-fit: cover; border-radius: var(--radius);" />
          </div>
        ` : ""}
        
        <div style="margin-bottom: 1rem;">
          <span style="color: var(--accent); font-weight: 600;">${escapeHtml(dateTimeHtml)}</span>
        </div>
        
        <h1 style="font-size: 1.8rem; font-weight: 700; line-height: 1.2; margin-bottom: 0.5rem;">
          ${escapeHtml(event.title)}
        </h1>
        
        ${event.account ? `
          <p class="text-muted mb-2">
            by <a href="/@${escapeHtml(event.account.username)}" style="color: var(--accent);">${escapeHtml(event.account.displayName || event.account.username)}</a>
          </p>
        ` : ""}
        
        ${event.location ? `
          <p class="mb-2" style="display: flex; align-items: center; gap: 0.35rem;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
            ${escapeHtml(event.location.name)}${event.location.address ? ` — ${escapeHtml(event.location.address)}` : ""}
          </p>
        ` : ""}
        
        ${event.description ? `
          <div class="event-description" style="margin-top: 1.5rem; line-height: 1.6;">
            ${event.description}
          </div>
        ` : ""}
        
        ${event.url ? `
          <p class="mt-2">
            <a href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; gap: 0.35rem;">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              ${event.source === "remote" ? "View on original site" : event.url}
            </a>
          </p>
        ` : ""}
        
        ${event.tags?.length > 0 ? `
          <div class="flex gap-1 mt-2" style="flex-wrap: wrap;">
            ${event.tags.map((tag: string) => `
              <span class="tag">${escapeHtml(tag)}</span>
            `).join("")}
          </div>
        ` : ""}
      </article>
    </main>
  </div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`;
}

function groupEventsByDate(events: any[]): Map<string, any[]> {
  const grouped = new Map<string, any[]>();
  for (const event of events) {
    const dateKey = event.startDate.split("T")[0];
    const existing = grouped.get(dateKey) || [];
    existing.push(event);
    grouped.set(dateKey, existing);
  }
  return grouped;
}

function formatDateHeading(dateKey: string, locale: string): string {
  const date = new Date(dateKey + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const eventDate = new Date(date);
  eventDate.setHours(0, 0, 0, 0);
  
  if (eventDate.getTime() === today.getTime()) {
    return locale === "de" ? "Heute" : "Today";
  }
  if (eventDate.getTime() === tomorrow.getTime()) {
    return locale === "de" ? "Morgen" : "Tomorrow";
  }
  
  return date.toLocaleDateString(locale === "de" ? "de-AT" : "en", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
