/**
 * Escape LIKE pattern metacharacters so user input is matched literally.
 * Call this before wrapping with %..% for search queries.
 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * SQL fragment for a single LIKE comparison that pairs the placeholder
 * with an ESCAPE clause. SQLite has no default escape character, so the
 * backslashes produced by escapeLike() are treated as literal characters
 * unless ESCAPE '\\' is present. Always pair this with a parameter
 * produced by containsPattern() (or another pattern run through
 * escapeLike()).
 */
export function likeClause(column: string): string {
  return `${column} LIKE ? ESCAPE '\\'`;
}

/**
 * Wrap a user-supplied search value as a substring pattern (matches
 * anywhere in the column). Pair the result with a likeClause() fragment
 * so the ESCAPE clause is present.
 */
export function containsPattern(s: string): string {
  return `%${escapeLike(s)}%`;
}
