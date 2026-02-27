import type { PageContext } from "../../renderer/types";
import type { DataAsync } from "vike/types";

export { data };
export type Data = {
  profile: Awaited<ReturnType<typeof fetchProfile>>["profile"];
  events: Awaited<ReturnType<typeof fetchProfileEvents>>["events"];
  error?: string;
};

const API_BASE = process.env.API_BASE || "http://localhost:3000";

async function fetchProfile(username: string) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/users/${encodeURIComponent(username)}`, {
      headers: {
        "Accept": "application/json",
      },
    });
    if (!res.ok) {
      if (res.status === 404) {
        return { profile: null };
      }
      throw new Error(`Failed to fetch profile: ${res.status}`);
    }
    const profile = await res.json();
    return { profile };
  } catch (e) {
    console.error("Error fetching profile:", e);
    return { profile: null };
  }
}

async function fetchProfileEvents(username: string) {
  try {
    const res = await fetch(
      `${API_BASE}/api/v1/users/${encodeURIComponent(username)}/events?from=${new Date().toISOString()}&limit=100&sort=asc`,
      {
        headers: {
          "Accept": "application/json",
        },
      }
    );
    if (!res.ok) {
      return { events: [] };
    }
    const data = await res.json();
    return { events: data.events || [] };
  } catch (e) {
    console.error("Error fetching profile events:", e);
    return { events: [] };
  }
}

const data: DataAsync<Data> = async (pageContext): Promise<Data & { documentProps?: PageContext["documentProps"] }> => {
  const { urlParsed } = pageContext;
  const username = urlParsed.search.username as string;

  if (!username) {
    return { profile: null, events: [], error: "Username not provided" };
  }

  const [{ profile }, { events }] = await Promise.all([
    fetchProfile(username),
    fetchProfileEvents(username),
  ]);

  // Generate OG tags for profile
  const displayName = profile?.displayName || username;
  const description = profile?.bio 
    ? `${displayName} — ${profile.bio.slice(0, 150)}${profile.bio.length > 150 ? '...' : ''}`
    : `Profile of ${displayName} on EveryCal`;

  return {
    profile,
    events,
    error: !profile ? "User not found" : undefined,
    documentProps: {
      title: `${displayName} (@${username}) — EveryCal`,
      description,
      ogImage: profile?.avatarUrl || "/og-image.png",
    },
  };
};
