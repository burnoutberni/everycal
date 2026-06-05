/**
 * Shared CSRF token utilities for browser cookie-auth requests.
 */

export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)everycal_csrf=([^;]+)/);
  return match?.[1] || null;
}

export function shouldAttachCsrf(method?: string): boolean {
  const normalizedMethod = (method || "GET").toUpperCase();
  return normalizedMethod !== "GET" && normalizedMethod !== "HEAD" && normalizedMethod !== "OPTIONS";
}
