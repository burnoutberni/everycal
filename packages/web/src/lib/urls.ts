/** Build the canonical URL path for an event. */
export function eventPath(event: {
  slug?: string;
  account?: { username: string; domain?: string } | null;
  id: string;
  source?: "local" | "remote";
}): string {
  if (event.source === "remote" && event.account?.username) {
    // Remote: /@username@domain/:eventId (eventId = base64url of URI)
    return remoteEventPath(event.account.username, event.id);
  }
  if (event.slug && event.account?.username) {
    return `/@${event.account.username}/${event.slug}`;
  }
  // Fallback for events without slug (legacy)
  return `/events/${event.id}`;
}

/** Build the canonical URL path for a user profile. */
export function profilePath(username: string, domain?: string): string {
  if (domain) {
    return remoteProfilePath(username, domain);
  }
  return `/@${username}`;
}

/** Build path for remote profile: /@username@domain */
export function remoteProfilePath(username: string, domain: string): string {
  return `/@${username}@${domain}`;
}

/** Build path for remote event: /@username@domain/:eventId */
export function remoteEventPath(usernameAtDomain: string, eventUri: string): string {
  const eventId = btoa(unescape(encodeURIComponent(eventUri)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `/@${usernameAtDomain}/${eventId}`;
}

/** Decode base64url eventId back to URI */
export function decodeRemoteEventId(eventId: string): string {
  const base64 = eventId.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  return decodeURIComponent(escape(atob(padded)));
}
