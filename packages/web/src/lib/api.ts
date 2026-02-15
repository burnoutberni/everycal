/**
 * API client for the EveryCal server.
 *
 * Auth is handled via HttpOnly session cookies set by the server.
 * The Bearer token header is still supported for API key users (scripts/scrapers).
 */

const BASE = "/api/v1";

/**
 * Optional API key for script/scraper usage.
 * Web UI users authenticate via HttpOnly cookies (no JS token access).
 */
let apiKey: string | null = null;

export function setApiKey(key: string | null) {
  apiKey = key;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  // Only set Authorization header for API key usage (scripts/scrapers)
  if (apiKey) {
    headers["Authorization"] = `ApiKey ${apiKey}`;
  }

  // Don't set Content-Type for FormData (browser sets multipart boundary)
  if (!(options.body instanceof FormData) && options.body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    // Include cookies for session-based auth (HttpOnly cookie set by server)
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || "Request failed");
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// ---- Auth ----

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  website?: string | null;
  isBot?: boolean;
  discoverable?: boolean;
  followersCount?: number;
  followingCount?: number;
  following?: boolean;
  autoReposting?: boolean;
  createdAt?: string;
}

export interface AuthResponse {
  user: User;
  expiresAt: string;
}

export const auth = {
  register(username: string, password: string, displayName?: string) {
    return request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, displayName }),
    });
  },

  login(username: string, password: string) {
    return request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  logout() {
    return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
  },

  me() {
    return request<User>("/auth/me");
  },

  updateProfile(data: { displayName?: string; bio?: string; website?: string; avatarUrl?: string; discoverable?: boolean }) {
    return request<{ ok: boolean }>("/auth/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  deleteAccount() {
    return request<{ ok: boolean }>("/auth/me", { method: "DELETE" });
  },

  listApiKeys() {
    return request<{ keys: { id: string; label: string; lastUsedAt: string | null; createdAt: string }[] }>(
      "/auth/api-keys"
    );
  },

  createApiKey(label: string) {
    return request<{ id: string; key: string; label: string }>("/auth/api-keys", {
      method: "POST",
      body: JSON.stringify({ label }),
    });
  },

  deleteApiKey(id: string) {
    return request<{ ok: boolean }>(`/auth/api-keys/${id}`, { method: "DELETE" });
  },
};

// ---- Events ----

export interface CalEvent {
  id: string;
  slug?: string;
  source?: "local" | "remote";
  accountId?: string;
  actorUri?: string;
  account?: { username: string; displayName: string | null; domain?: string; iconUrl?: string };
  title: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  allDay: boolean;
  location: { name: string; address?: string; latitude?: number; longitude?: number; url?: string } | null;
  image: { url: string; mediaType?: string; alt?: string } | null;
  url: string | null;
  tags: string[];
  visibility: string;
  rsvpStatus?: "going" | "maybe" | "interested" | null;
  reposted?: boolean;
  repostedBy?: { username: string; displayName: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface EventInput {
  title: string;
  description?: string;
  startDate: string;
  endDate?: string;
  allDay?: boolean;
  location?: { name: string; address?: string; latitude?: number; longitude?: number; url?: string };
  image?: { url: string; mediaType?: string; alt?: string };
  url?: string;
  tags?: string[];
  visibility?: string;
}

export const events = {
  list(params?: { account?: string; from?: string; to?: string; q?: string; source?: string; scope?: string; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ events: CalEvent[] }>(`/events?${qs}`);
  },

  get(id: string) {
    return request<CalEvent>(`/events/${id}`);
  },

  getBySlug(username: string, slug: string) {
    return request<CalEvent>(`/events/by-slug/${username}/${slug}`);
  },

  create(data: EventInput) {
    return request<CalEvent>("/events", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(id: string, data: Partial<EventInput>) {
    return request<CalEvent>(`/events/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  delete(id: string) {
    return request<{ ok: boolean }>(`/events/${id}`, { method: "DELETE" });
  },

  repost(id: string) {
    return request<{ ok: boolean; reposted: boolean }>(`/events/${id}/repost`, { method: "POST" });
  },

  unrepost(id: string) {
    return request<{ ok: boolean; reposted: boolean }>(`/events/${id}/repost`, { method: "DELETE" });
  },

  rsvp(eventUri: string, status: "going" | "maybe" | "interested" | null) {
    return request<{ ok: boolean; status: string | null }>("/events/rsvp", {
      method: "POST",
      body: JSON.stringify({ eventUri, status }),
    });
  },
};

// ---- Users ----

export const users = {
  list(params?: { q?: string; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ users: User[] }>(`/users?${qs}`);
  },

  get(username: string) {
    return request<User>(`/users/${username}`);
  },

  events(username: string, params?: { from?: string; to?: string; limit?: number; sort?: "asc" | "desc" }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ events: CalEvent[] }>(`/users/${username}/events?${qs}`);
  },

  follow(username: string) {
    return request<{ ok: boolean; following: boolean }>(`/users/${username}/follow`, { method: "POST" });
  },

  unfollow(username: string) {
    return request<{ ok: boolean; following: boolean }>(`/users/${username}/unfollow`, { method: "POST" });
  },

  autoRepost(username: string) {
    return request<{ ok: boolean; autoReposting: boolean }>(`/users/${username}/auto-repost`, { method: "POST" });
  },

  removeAutoRepost(username: string) {
    return request<{ ok: boolean; autoReposting: boolean }>(`/users/${username}/auto-repost`, { method: "DELETE" });
  },

  followers(username: string) {
    return request<{ users: User[] }>(`/users/${username}/followers`);
  },

  following(username: string) {
    return request<{ users: User[] }>(`/users/${username}/following`);
  },
};

// ---- Uploads ----

export const uploads = {
  upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    return request<{ url: string; mediaType: string; filename: string }>("/uploads", {
      method: "POST",
      body: form,
    });
  },
};

// ---- Federation ----

export interface RemoteActor {
  uri: string;
  type: string;
  username: string;
  displayName: string;
  summary: string | null;
  domain: string;
  iconUrl: string | null;
  imageUrl: string | null;
  outbox: string | null;
}

export const federation = {
  search(q: string) {
    const qs = new URLSearchParams({ q });
    return request<{ actor: RemoteActor }>(`/federation/search?${qs}`);
  },

  fetchActor(actorUri: string) {
    return request<{ ok: boolean; imported: number; total: number }>("/federation/fetch-actor", {
      method: "POST",
      body: JSON.stringify({ actorUri }),
    });
  },

  follow(actorUri: string) {
    return request<{ ok: boolean; delivered: boolean }>("/federation/follow", {
      method: "POST",
      body: JSON.stringify({ actorUri }),
    });
  },

  unfollow(actorUri: string) {
    return request<{ ok: boolean }>("/federation/unfollow", {
      method: "POST",
      body: JSON.stringify({ actorUri }),
    });
  },

  followedActors() {
    return request<{ actors: RemoteActor[] }>("/federation/following");
  },

  remoteEvents(params?: { actor?: string; from?: string; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ events: CalEvent[] }>(`/federation/remote-events?${qs}`);
  },

  actors(params?: { domain?: string; limit?: number }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ actors: RemoteActor[] }>(`/federation/actors?${qs}`);
  },
};
