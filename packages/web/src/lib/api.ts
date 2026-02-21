/**
 * API client for the EveryCal server.
 *
 * Auth is handled via HttpOnly session cookies set by the server.
 * The Bearer token header is still supported for API key users (scripts/scrapers).
 */

const API_PATH = "/api/v1";

/**
 * Build API URL without embedded credentials.
 * Relative URLs are resolved against document URL, which can inherit credentials
 * (e.g. from proxy or user@host) and cause fetch to throw.
 */
function apiUrl(path: string): string {
  const origin = `${window.location.protocol}//${window.location.host}`;
  return `${origin}${API_PATH}${path}`;
}

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

  const res = await fetch(apiUrl(path), {
    ...options,
    headers,
    // Include cookies for session-based auth (HttpOnly cookie set by server)
    credentials: "include",
    // Prevent stale cached responses (e.g. profile event count after creating an event)
    cache: "no-store",
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

export interface NotificationPrefs {
  reminderEnabled: boolean;
  reminderHoursBefore: number;
  eventUpdatedEnabled: boolean;
  eventCancelledEnabled: boolean;
  onboardingCompleted: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  website?: string | null;
  isBot?: boolean;
  discoverable?: boolean;
  city?: string | null;
  cityLat?: number | null;
  cityLng?: number | null;
  email?: string | null;
  emailVerified?: boolean;
  notificationPrefs?: NotificationPrefs;
  followersCount?: number;
  followingCount?: number;
  eventsCount?: number;
  following?: boolean;
  autoReposting?: boolean;
  createdAt?: string;
  source?: "local" | "remote";
  domain?: string;
}

export interface AuthResponse {
  user: User;
  expiresAt: string;
}

export const auth = {
  register(
    username: string,
    password: string,
    displayName?: string,
    city?: string,
    cityLat?: number,
    cityLng?: number,
    email?: string
  ) {
    return request<AuthResponse | { requiresVerification: true; email: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, displayName, city, cityLat, cityLng, email }),
    });
  },

  verifyEmail(token: string) {
    return request<AuthResponse & { redirectTo?: string; ok?: boolean; emailChanged?: boolean }>(
      "/auth/verify-email?token=" + encodeURIComponent(token)
    );
  },

  requestEmailChange(email: string) {
    return request<{ ok: boolean; email: string }>("/auth/request-email-change", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },

  changePassword(currentPassword: string, newPassword: string) {
    return request<{ ok: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  forgotPassword(email: string) {
    return request<{ ok: boolean }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },

  resetPassword(token: string, newPassword: string) {
    return request<{ ok: boolean }>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    });
  },

  updateNotificationPrefs(prefs: Partial<NotificationPrefs>) {
    return request<{ ok: boolean }>("/auth/notification-prefs", {
      method: "PATCH",
      body: JSON.stringify(prefs),
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

  updateProfile(data: { displayName?: string; bio?: string; website?: string; avatarUrl?: string; discoverable?: boolean; city?: string; cityLat?: number; cityLng?: number }) {
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

// ---- Saved Locations ----

export interface SavedLocation {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  usedAt: string;
}

export const locations = {
  list() {
    return request<SavedLocation[]>("/locations");
  },
  save(loc: { name: string; address?: string; latitude?: number; longitude?: number }) {
    return request<{ ok: boolean }>("/locations", {
      method: "POST",
      body: JSON.stringify(loc),
    });
  },
  delete(id: number) {
    return request<{ ok: boolean }>(`/locations/${id}`, { method: "DELETE" });
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
  image: { url: string; mediaType?: string; alt?: string; attribution?: ImageAttribution } | null;
  url: string | null;
  tags: string[];
  visibility: string;
  /** True for remote events that were canceled (ActivityPub Delete). */
  canceled?: boolean;
  rsvpStatus?: "going" | "maybe" | null;
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
  image?: { url: string; mediaType?: string; alt?: string; attribution?: ImageAttribution };
  url?: string;
  tags?: string[];
  visibility?: string;
}

export const events = {
  list(params?: { account?: string; from?: string; to?: string; q?: string; source?: string; scope?: string; tags?: string[]; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        if (k === "tags" && Array.isArray(v)) {
          if (v.length > 0) qs.set("tags", v.join(","));
        } else {
          qs.set(k, String(v));
        }
      }
    }
    return request<{ events: CalEvent[] }>(`/events?${qs}`);
  },

  tags(params?: { from?: string; to?: string; scope?: string }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ tags: string[] }>(`/events/tags?${qs}`);
  },

  get(id: string) {
    return request<CalEvent>(`/events/${encodeURIComponent(id)}`);
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

  rsvp(eventUri: string, status: "going" | "maybe" | null) {
    return request<{ ok: boolean; status: string | null }>("/events/rsvp", {
      method: "POST",
      body: JSON.stringify({ eventUri, status }),
    });
  },
};

// ---- Feeds ----

export const feeds = {
  /** Get the iCal feed URL for the current user's calendar (Going/Maybe events). */
  getCalendarUrl() {
    return request<{ url: string }>("/feeds/calendar-url");
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

// ---- Image search (Unsplash / Openverse) ----

export interface ImageSources {
  sources: string[];
  unsplashAvailable: boolean;
}

export interface ImageAttribution {
  source: "unsplash" | "openverse";
  title?: string;
  sourceUrl?: string;
  creator?: string;
  creatorUrl?: string;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  downloadLocation?: string;
}

export interface ImageSearchResult {
  url: string;
  attribution?: ImageAttribution;
}

export const images = {
  /** Get available image sources and Openverse license options. */
  async getSources(): Promise<ImageSources | null> {
    try {
      const res = await fetch(apiUrl("/images/sources"), { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  },

  /** Search for header images by query. Returns url + attribution for each result. */
  async search(
    query: string,
    limit = 12,
    page = 1,
    options?: { source?: string }
  ): Promise<{ results: ImageSearchResult[]; source?: string } | null> {
    const q = encodeURIComponent(query.trim());
    if (q.length < 2) return null;
    const params = new URLSearchParams({
      q,
      limit: String(limit),
      page: String(page),
    });
    if (options?.source) params.set("source", options.source);
    try {
      const res = await fetch(apiUrl(`/images/search?${params}`), {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { results?: ImageSearchResult[]; source?: string };
      return data.results?.length ? { results: data.results, source: data.source } : null;
    } catch {
      return null;
    }
  },

  /** Trigger Unsplash download tracking when user selects an image (per API guidelines). */
  async triggerDownload(downloadLocation: string): Promise<void> {
    try {
      await fetch(apiUrl("/images/trigger-download"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ downloadLocation }),
      });
    } catch {
      // Non-critical
    }
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
  outbox?: string | null;
  eventsCount?: number;
  followersCount?: number;
  followingCount?: number;
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

  refreshActors(params?: { limit?: number; maxAgeHours?: number }) {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.maxAgeHours !== undefined) qs.set("maxAgeHours", String(params.maxAgeHours));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<{ refreshed: number; discovered?: number }>(`/federation/refresh-actors${suffix}`, {
      method: "POST",
    });
  },
};
