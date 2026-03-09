/** Build the events page path with optional tag filters. */
export function eventsPathWithTags(tags: string[]): string {
  if (tags.length === 0) return "/";
  return `/?tags=${encodeURIComponent(tags.join(","))}`;
}

/** Build the canonical URL path for an event. */
export function eventPath(event: {
  slug?: string;
  account?: { username: string; domain?: string } | null;
  id: string;
  source?: "local" | "remote";
}): string {
  if (event.slug && event.account?.username) {
    return `/@${event.account.username}/${event.slug}`;
  }
  if (event.source === "remote") {
    return remoteEventResolvePath(event.id);
  }
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

/**
 * Build profile path for an event account.
 * Handles remote events where account.username is already "user@domain" and account.domain is set;
 * avoids malformed URLs like /@user@domain@domain.
 */
export function accountProfilePath(
  account: { username: string; domain?: string } | null,
  source?: "local" | "remote"
): string {
  if (!account) return "#";
  if (source === "remote" && account.domain) {
    const atIdx = account.username.indexOf("@");
    const usernamePart = atIdx >= 0 ? account.username.slice(0, atIdx) : account.username;
    return remoteProfilePath(usernamePart, account.domain);
  }
  return profilePath(account.username);
}

/** Bootstrap path for resolving remote event URI to canonical local slug URL. */
export function remoteEventResolvePath(eventUri: string): string {
  return `/r/event?uri=${encodeURIComponent(eventUri)}`;
}
