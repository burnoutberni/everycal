import type { PageContext } from "../../renderer/types";
import type { DataAsync } from "vike/types";

export { data };
export type Data = {
  event: Awaited<ReturnType<typeof fetchEvent>>;
  error?: string;
};

const API_BASE = process.env.API_BASE || "http://localhost:3000";

async function fetchEvent(username: string, slug: string) {
  try {
    // Handle remote events (username contains @)
    if (username.includes("@")) {
      const res = await fetch(
        `${API_BASE}/api/v1/events/${encodeURIComponent(slug)}?remote=1`,
        {
          headers: {
            "Accept": "application/json",
          },
        }
      );
      if (!res.ok) {
        if (res.status === 404) {
          return null;
        }
        throw new Error(`Failed to fetch event: ${res.status}`);
      }
      return await res.json();
    }
    
    // Local event by slug
    const res = await fetch(
      `${API_BASE}/api/v1/events/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`,
      {
        headers: {
          "Accept": "application/json",
        },
      }
    );
    if (!res.ok) {
      if (res.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch event: ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    console.error("Error fetching event:", e);
    return null;
  }
}

function formatEventDescription(event: NonNullable<Awaited<ReturnType<typeof fetchEvent>>>): string {
  const parts: string[] = [];
  
  // Add date
  if (event.startDate) {
    const date = new Date(event.startDate);
    parts.push(date.toLocaleDateString());
  }
  
  // Add location
  if (event.location?.name) {
    parts.push(event.location.name);
  }
  
  // Add truncated description
  if (event.description) {
    // Strip HTML tags for description
    const textDesc = event.description.replace(/<[^>]*>/g, '').slice(0, 100);
    if (textDesc) {
      parts.push(textDesc + (event.description.length > 100 ? '...' : ''));
    }
  }
  
  return parts.join(' • ') || `Event by @${event.account?.username || 'unknown'}`;
}

const data: DataAsync<Data> = async (pageContext): Promise<Data & { documentProps?: PageContext["documentProps"] }> => {
  const { urlParsed } = pageContext;
  const username = urlParsed.search.username as string;
  const slug = urlParsed.search.slug as string;

  if (!username || !slug) {
    return { event: null, error: "Event identifier not provided" };
  }

  const event = await fetchEvent(username, slug);

  // Generate OG tags for event
  let documentProps: PageContext["documentProps"] | undefined;
  
  if (event) {
    const description = formatEventDescription(event);
    const ogImage = event.ogImageUrl || event.image?.url || "/og-image.png";
    
    documentProps = {
      title: `${event.title} — EveryCal`,
      description,
      ogImage,
    };
  }

  return {
    event,
    error: !event ? "Event not found" : undefined,
    documentProps,
  };
};
