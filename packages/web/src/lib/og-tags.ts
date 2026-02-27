/**
 * OG Tag generation for SSR.
 * Generates dynamic Open Graph and Twitter meta tags based on page context.
 */

import type { CalEvent } from "./api";
import type { User } from "./api";
import { formatEventDateTime } from "./formatEventDateTime";

export interface OgTags {
  title: string;
  description: string;
  ogImage?: string;
  ogImageType?: string;
}

/** Default meta tags */
const defaults = {
  title: "EveryCal",
  description: "Federated event calendar — self-host, discover events, connect via ActivityPub.",
  ogImage: "/og-image.png",
};

/** Generate OG tags based on page context */
export function generateOgTags(
  pageContext: {
    urlPathname: string;
    data?: any;
    pageProps?: any;
  },
  locale: string
): OgTags {
  const { urlPathname } = pageContext;
  
  // Match /@username route - profile page
  const profileMatch = urlPathname.match(/^\/@([^/]+)\/?$/);
  if (profileMatch) {
    const profile = pageContext.data?.profile as User | undefined;
    if (profile) {
      return {
        title: `${profile.displayName || profile.username} (@${profile.username}) — EveryCal`,
        description: profile.bio 
          ? profile.bio 
          : `Events from ${profile.displayName || profile.username} on EveryCal`,
        ogImage: profile.avatarUrl || undefined,
      };
    }
    return {
      title: `@${profileMatch[1]} — EveryCal`,
      description: `View profile on EveryCal`,
    };
  }
  
  // Match /@username/:slug route - event page  
  const eventMatch = urlPathname.match(/^\/@([^/]+)\/([^/]+)\/?$/);
  if (eventMatch) {
    const event = pageContext.data?.event as CalEvent | undefined;
    if (event) {
      const eventDateTime = event.location?.name
        ? `${formatEventDateTime(event, true, { locale, allDayLabel: "" })} • ${event.location.name}`
        : formatEventDateTime(event, true, { locale, allDayLabel: "" });
      
      return {
        title: `${event.title} — EveryCal`,
        description: eventDateTime,
        ogImage: event.ogImageUrl || event.image?.url || undefined,
        ogImageType: event.image?.mediaType || undefined,
      };
    }
    return {
      title: `Event — EveryCal`,
      description: `View event on EveryCal`,
    };
  }
  
  // Default tags
  return defaults;
}
