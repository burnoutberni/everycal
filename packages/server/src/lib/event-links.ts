/** Derive a stable fallback slug from an event URI/id. */
export function fallbackSlugFromUri(uri: string): string {
  const trimmed = uri.replace(/\/$/, "");
  const last = trimmed.split("/").pop() || trimmed;
  return last || "event";
}
