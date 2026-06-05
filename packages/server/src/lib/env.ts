/**
 * Safe NODE_ENV helper for security-sensitive checks.
 *
 * Treats undefined NODE_ENV as production (fail-closed) so that security
 * features are never silently disabled when the variable is missing.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NODE_ENV === undefined;
}
