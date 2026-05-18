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

export function getBaseUrlFromRequest(requestUrl: string, fallback?: string): string {
  const envBase = process.env.BASE_URL;
  if (envBase && envBase.trim().length > 0) return getBaseUrl(fallback);
  try {
    const parsed = new URL(requestUrl);
    return getBaseUrl(parsed.origin);
  } catch {
    return getBaseUrl(fallback);
  }
}

export function buildActorUrl(username: string, baseUrl = getBaseUrl()): string {
  return `${baseUrl}/users/${username}`;
}

export function buildProfileUrl(username: string, baseUrl = getBaseUrl()): string {
  return `${baseUrl}/@${username}`;
}

export function buildEventUrl(username: string, slug: string, domain?: string | null, baseUrl = getBaseUrl()): string {
  const localUsername = domain && username.includes("@") ? username.split("@")[0] : username;
  const domainPart = domain ? `@${domain}` : "";
  return `${baseUrl}/@${localUsername}${domainPart}/${slug}`;
}

export function buildUploadUrl(filename: string, baseUrl = getBaseUrl()): string {
  return `${baseUrl}/uploads/${filename}`;
}
