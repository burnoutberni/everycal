/**
 * Escape LIKE pattern metacharacters so user input is matched literally.
 * Call this before wrapping with %..% for search queries.
 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
