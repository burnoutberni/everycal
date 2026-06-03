import { getBaseUrl } from "../lib/base-url.js";

const DEV_ADMIN_ORIGIN = "http://localhost:5173";

export function getAllowedAdminOrigins(): Set<string> {
  const origins = new Set<string>();

  try {
    origins.add(new URL(getBaseUrl()).origin);
  } catch {
    // Leave the set empty when BASE_URL is invalid or unavailable.
  }

  if (process.env.NODE_ENV !== "production") {
    origins.add(DEV_ADMIN_ORIGIN);
  }

  return origins;
}

export function isAllowedAdminOrigin(origin: string | null): boolean {
  return origin !== null && getAllowedAdminOrigins().has(origin);
}
