/** Build the canonical URL path for an event. */
export function eventPath(event: { slug?: string; account?: { username: string } | null; id: string }): string {
  if (event.slug && event.account?.username) {
    return `/@${event.account.username}/${event.slug}`;
  }
  // Fallback for events without slug (legacy, remote)
  return `/events/${event.id}`;
}

/** Build the canonical URL path for a user profile. */
export function profilePath(username: string): string {
  return `/@${username}`;
}
