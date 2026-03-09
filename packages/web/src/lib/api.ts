/**
 * API client for the EveryCal server.
 *
 * Auth is handled via HttpOnly session cookies set by the server.
 * The Bearer token header is still supported for API key users (scripts/scrapers).
 */

import i18n from "i18next";

const API_PATH = "/api/v1";

export interface ApiRequestContext {
  cookie?: string;
  apiOrigin?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function getInternalApiOrigin(): string {
  const explicit = process.env.API_INTERNAL_URL;
  if (explicit) {
    const normalized = normalizeOrigin(explicit);
    if (normalized) return normalized;
  }
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

function shouldForwardCookie(targetOrigin: string): boolean {
  return isLoopbackOrigin(targetOrigin);
}

/**
 * Build API URL without embedded credentials.
 * Relative URLs are resolved against document URL, which can inherit credentials
 * (e.g. from proxy or user@host) and cause fetch to throw.
 */
function apiUrl(path: string, context?: ApiRequestContext): string {
  if (typeof window === "undefined") {
    const origin = context?.apiOrigin || getInternalApiOrigin();
    return `${origin}${API_PATH}${path}`;
  }
  const origin = `${window.location.protocol}//${window.location.host}`;
  return `${origin}${API_PATH}${path}`;
}

export function createApiRequestContext(input?: {
  headersOriginal?: Record<string, string | string[] | undefined>;
}): ApiRequestContext {
  const cookieHeader = input?.headersOriginal?.cookie;
  const cookie = typeof cookieHeader === "string" ? cookieHeader : undefined;
  return {
    cookie,
    apiOrigin: getInternalApiOrigin(),
  };
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
  options: RequestInit = {},
  context?: ApiRequestContext
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (apiKey) {
    headers["Authorization"] = `ApiKey ${apiKey}`;
  }

  const targetOrigin = typeof window === "undefined"
    ? context?.apiOrigin || getInternalApiOrigin()
    : "";

  if (typeof window === "undefined" && context?.cookie && shouldForwardCookie(targetOrigin)) {
    headers["Cookie"] = context.cookie;
  }

  // Don't set Content-Type for FormData (browser sets multipart boundary)
  if (!(options.body instanceof FormData) && options.body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(apiUrl(path, context), {
    ...options,
    headers,
    // Include cookies for session-based auth (HttpOnly cookie set by server)
    credentials: "include",
    // Prevent stale cached responses (e.g. profile event count after creating an event)
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || i18n.t("common:requestFailed"));
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

export interface ActorSelectionStateResponse {
  activeAccountIds: string[];
  actorIds: string[];
}

export interface ActorSelectionApplyResult {
  accountId: string;
  before: boolean;
  after: boolean;
  status: "added" | "removed" | "unchanged" | "error";
  message?: string;
  remoteStatus?: "none" | "pending" | "delivered" | "failed";
}

export interface ActorSelectionApplyResponse {
  ok: boolean;
  operationId?: string;
  added: number;
  removed: number;
  unchanged: number;
  failed: number;
  results: ActorSelectionApplyResult[];
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
  accountType?: "person" | "identity";
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
  preferredLanguage?: string;
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

  me(context?: ApiRequestContext) {
    return request<User>("/auth/me", {}, context);
  },

  updateProfile(data: { displayName?: string; bio?: string; website?: string; avatarUrl?: string; discoverable?: boolean; city?: string | null; cityLat?: number | null; cityLng?: number | null; preferredLanguage?: string }) {
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
  ogImageUrl?: string | null;
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
  postAsAccountId?: string;
}

export type IdentityRole = "editor" | "owner";

export interface PublishingIdentity {
  id: string;
  username: string;
  accountType: "person" | "identity";
  role: IdentityRole;
  displayName: string | null;
  bio: string | null;
  website: string | null;
  avatarUrl: string | null;
  discoverable: boolean;
  defaultVisibility: "public" | "unlisted" | "followers_only" | "private";
  city: string | null;
  cityLat: number | null;
  cityLng: number | null;
  preferredLanguage: "en" | "de";
}

export interface IdentityMember {
  memberId: string;
  username: string;
  displayName: string | null;
  role: IdentityRole;
  createdAt?: string;
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

  get(id: string, context?: ApiRequestContext) {
    return request<CalEvent>(`/events/${encodeURIComponent(id)}`, {}, context);
  },

  getBySlug(username: string, slug: string, context?: ApiRequestContext) {
    return request<CalEvent>(`/events/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`, {}, context);
  },

  resolve(uri: string, context?: ApiRequestContext) {
    return request<{ path: string; event: CalEvent | null }>(`/events/resolve?uri=${encodeURIComponent(uri)}`, {}, context);
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

  repostActors(id: string) {
    return request<ActorSelectionStateResponse>(`/events/${id}/repost-actors`);
  },

  setRepostActors(id: string, desiredAccountIds: string[]) {
    return request<ActorSelectionApplyResponse>(`/events/${id}/repost`, {
      method: "POST",
      body: JSON.stringify({ desiredAccountIds }),
    });
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

export const identities = {
  list() {
    return request<{ identities: PublishingIdentity[] }>("/identities");
  },

  create(data: {
    username: string;
    displayName?: string;
    bio?: string;
    website?: string;
    avatarUrl?: string;
    discoverable?: boolean;
    defaultVisibility?: "public" | "unlisted" | "followers_only" | "private";
    city?: string | null;
    cityLat?: number | null;
    cityLng?: number | null;
    preferredLanguage?: "en" | "de";
  }) {
    return request<{ identity: PublishingIdentity }>("/identities", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  update(username: string, data: {
    displayName?: string;
    bio?: string;
    website?: string | null;
    avatarUrl?: string | null;
    discoverable?: boolean;
    defaultVisibility?: "public" | "unlisted" | "followers_only" | "private";
    city?: string | null;
    cityLat?: number | null;
    cityLng?: number | null;
    preferredLanguage?: "en" | "de";
  }) {
    return request<{ identity: PublishingIdentity }>(`/identities/${encodeURIComponent(username)}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  delete(username: string) {
    return request<{ ok: boolean }>(`/identities/${encodeURIComponent(username)}`, {
      method: "DELETE",
    });
  },

  listMembers(username: string) {
    return request<{ members: IdentityMember[] }>(`/identities/${encodeURIComponent(username)}/members`);
  },

  addMember(username: string, memberUsername: string, role: IdentityRole) {
    return request<{ member: IdentityMember }>(`/identities/${encodeURIComponent(username)}/members`, {
      method: "POST",
      body: JSON.stringify({ memberUsername, role }),
    });
  },

  updateMember(username: string, memberId: string, role: IdentityRole) {
    return request<{ member: IdentityMember }>(
      `/identities/${encodeURIComponent(username)}/members/${encodeURIComponent(memberId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }
    );
  },

  removeMember(username: string, memberId: string) {
    return request<{ ok: boolean }>(`/identities/${encodeURIComponent(username)}/members/${encodeURIComponent(memberId)}`, {
      method: "DELETE",
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

  get(username: string, context?: ApiRequestContext) {
    return request<User>(`/users/${username}`, {}, context);
  },

  events(
    username: string,
    params?: { from?: string; to?: string; limit?: number; sort?: "asc" | "desc" },
    context?: ApiRequestContext
  ) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ events: CalEvent[] }>(`/users/${username}/events?${qs}`, {}, context);
  },

  follow(username: string) {
    return request<{ ok: boolean; following: boolean }>(`/users/${username}/follow`, { method: "POST" });
  },

  followActors(username: string) {
    return request<ActorSelectionStateResponse>(`/users/${username}/follow-actors`);
  },

  setFollowActors(username: string, desiredAccountIds: string[]) {
    return request<ActorSelectionApplyResponse>(`/users/${username}/follow`, {
      method: "POST",
      body: JSON.stringify({ desiredAccountIds }),
    });
  },

  unfollow(username: string) {
    return request<{ ok: boolean; following: boolean }>(`/users/${username}/unfollow`, { method: "POST" });
  },

  autoRepost(username: string) {
    return request<{ ok: boolean; autoReposting: boolean }>(`/users/${username}/auto-repost`, { method: "POST" });
  },

  autoRepostActors(username: string) {
    return request<ActorSelectionStateResponse>(`/users/${username}/auto-repost-actors`);
  },

  setAutoRepostActors(username: string, desiredAccountIds: string[]) {
    return request<ActorSelectionApplyResponse>(`/users/${username}/auto-repost`, {
      method: "POST",
      body: JSON.stringify({ desiredAccountIds }),
    });
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

  followActors(actorUri: string) {
    return request<ActorSelectionStateResponse>(`/federation/follow-actors?actorUri=${encodeURIComponent(actorUri)}`);
  },

  setFollowActors(actorUri: string, desiredAccountIds: string[]) {
    return request<ActorSelectionApplyResponse>("/federation/follow", {
      method: "POST",
      body: JSON.stringify({ actorUri, desiredAccountIds }),
    });
  },

  unfollow(actorUri: string) {
    return request<{ ok: boolean; delivered?: boolean }>("/federation/unfollow", {
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
