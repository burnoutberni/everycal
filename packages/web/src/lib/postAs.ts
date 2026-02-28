export function resolvePostAsAccountId(
  candidate: string | null | undefined,
  userId: string | null | undefined,
  allowedAccountIds: Set<string>
): string {
  if (!userId) return candidate || "";
  if (candidate && allowedAccountIds.has(candidate)) return candidate;
  return userId;
}
