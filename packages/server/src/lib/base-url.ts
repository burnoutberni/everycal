const DEFAULT_BASE_URL = "http://localhost:3000";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeAbsoluteUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("BASE_URL must use http or https");
  }
  if (!parsed.hostname) {
    throw new Error("BASE_URL must include a hostname");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = trimTrailingSlashes(parsed.pathname);
  return trimTrailingSlashes(parsed.toString());
}

export function getBaseUrl(fallback = DEFAULT_BASE_URL): string {
  const envBaseUrl = process.env.BASE_URL;
  const hasEnvBaseUrl = !!envBaseUrl && envBaseUrl.trim().length > 0;

  if (hasEnvBaseUrl) {
    return normalizeAbsoluteUrl(envBaseUrl);
  }

  return normalizeAbsoluteUrl(fallback);
}

export function validateBaseUrlConfig(): void {
  const envBaseUrl = process.env.BASE_URL;
  if (!envBaseUrl || envBaseUrl.trim().length === 0) {
    throw new Error("BASE_URL must be configured before starting the server");
  }
  try {
    normalizeAbsoluteUrl(envBaseUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid URL";
    throw new Error(`Invalid BASE_URL configuration: ${detail}`);
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
