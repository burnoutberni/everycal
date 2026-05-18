const DEFAULT_BASE_URL = "http://localhost:3000";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getBaseUrl(fallback = DEFAULT_BASE_URL): string {
  const raw = (process.env.BASE_URL && process.env.BASE_URL.trim().length > 0)
    ? process.env.BASE_URL
    : fallback;
  const normalized = raw.trim();

  try {
    const parsed = new URL(normalized);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = trimTrailingSlashes(parsed.pathname);
    return trimTrailingSlashes(parsed.toString());
  } catch {
    return trimTrailingSlashes(normalized);
  }
}
