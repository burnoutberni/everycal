import { getCsrfToken, shouldAttachCsrf } from './csrf';

async function parseJsonBody<T = any>(res: Response): Promise<T | undefined> {
  if (res.status === 204) return undefined;

  const contentType = res.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return undefined;

  return res.json() as Promise<T>;
}

export async function adminFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  if (shouldAttachCsrf(init?.method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }

  const res = await fetch(path, { credentials: "include", ...init, headers });

  if (!res.ok) {
    let serverError: string | null = null;
    try {
      const data = await parseJsonBody<{ error?: unknown }>(res);
      if (typeof data?.error === "string" && data.error.trim()) {
        serverError = data.error.trim();
      }
    } catch {}
    throw new Error(serverError ? `${serverError} (${res.status})` : `Request failed (${res.status})`);
  }

  return (await parseJsonBody<T>(res)) as T;
}
