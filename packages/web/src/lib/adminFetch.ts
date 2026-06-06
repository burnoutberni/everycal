import { apiRequest } from "./api";

async function parseJsonBody<T = unknown>(res: Response): Promise<T | undefined> {
  if (res.status === 204) return undefined;

  const contentType = res.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return undefined;

  return res.json() as Promise<T>;
}

export async function adminFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  return apiRequest<T>(path, init, {
    resolveUrl: (requestPath) => requestPath,
    parseResponse: async (res) => (await parseJsonBody<T>(res)) as T,
    parseError: async (res) => {
      let serverError: string | null = null;
      try {
        const data = await parseJsonBody<{ error?: unknown }>(res);
        if (typeof data?.error === "string" && data.error.trim()) {
          serverError = data.error.trim();
        }
      } catch {}
      return new Error(serverError ? `${serverError} (${res.status})` : `Request failed (${res.status})`);
    },
  });
}
