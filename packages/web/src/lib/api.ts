/**
 * API client for the EveryCal server.
 */

const BASE = "/api/v1";

let authToken: string | null = localStorage.getItem("everycal_token");

export function setToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem("everycal_token", token);
  } else {
    localStorage.removeItem("everycal_token");
  }
}

export function getToken(): string | null {
  return authToken;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  // Don't set Content-Type for FormData (browser sets multipart boundary)
  if (!(options.body instanceof FormData) && options.body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

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
  followersCount?: number;
  followingCount?: number;
  following?: boolean;
  createdAt?: string;
}

export interface AuthResponse {
  user: User;
  token: string;
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

  updateProfile(data: { displayName?: string; bio?: string; avatarUrl?: string }) {
    return request<{ ok: boolean }>("/auth/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
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
  accountId: string;
  account?: { username: string; displayName: string | null };
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
  list(params?: { account?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ events: CalEvent[] }>(`/events?${qs}`);
  },

  timeline(params?: { from?: string; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return request<{ events: CalEvent[] }>(`/events/timeline?${qs}`);
  },

  get(id: string) {
    return request<CalEvent>(`/events/${id}`);
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

  events(username: string, params?: { from?: string; to?: string; limit?: number }) {
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
