import { Link } from "wouter";
import DOMPurify from "dompurify";
import type { User } from "../lib/api";
import type { RemoteActor } from "../lib/api";

export type ProfileItem =
  | { kind: "local"; user: User }
  | { kind: "remote"; actor: RemoteActor };

export function getProfileKey(item: ProfileItem): string {
  return item.kind === "local" ? item.user.id : item.actor.uri;
}

export function getProfileHref(item: ProfileItem, profilePath: (u: string, d?: string) => string, remoteProfilePath: (u: string, d: string) => string): string {
  return item.kind === "local"
    ? profilePath(item.user.username)
    : remoteProfilePath(item.actor.username, item.actor.domain);
}

export function getProfileDisplayName(item: ProfileItem): string {
  return item.kind === "local"
    ? (item.user.displayName || item.user.username)
    : (item.actor.displayName || item.actor.username);
}

export function getProfileHandle(item: ProfileItem): string {
  return item.kind === "local"
    ? `@${item.user.username}`
    : `@${item.actor.username}@${item.actor.domain}`;
}

export function getProfileAvatar(item: ProfileItem): { url?: string; fallback: string } {
  if (item.kind === "local") {
    return {
      url: item.user.avatarUrl ?? undefined,
      fallback: item.user.username[0].toUpperCase(),
    };
  }
  return {
    url: item.actor.iconUrl ?? undefined,
    fallback: item.actor.username[0]?.toUpperCase() || "?",
  };
}

export function getProfileSummary(item: ProfileItem): string | null {
  if (item.kind === "local") return item.user.bio ?? null;
  return item.actor.summary ?? null;
}

export function getFollowersCount(item: ProfileItem): number | null {
  if (item.kind === "local" && item.user.followersCount != null) {
    return item.user.followersCount;
  }
  if (item.kind === "remote" && item.actor.followersCount != null) {
    return item.actor.followersCount;
  }
  return null;
}

export function getFollowingCount(item: ProfileItem): number | null {
  if (item.kind === "local" && item.user.followingCount != null) {
    return item.user.followingCount;
  }
  if (item.kind === "remote" && item.actor.followingCount != null) {
    return item.actor.followingCount;
  }
  return null;
}

export function getEventsCount(item: ProfileItem): number | null {
  if (item.kind === "local" && item.user.eventsCount != null) {
    return item.user.eventsCount;
  }
  if (item.kind === "remote" && item.actor.eventsCount != null) {
    return item.actor.eventsCount;
  }
  return null;
}

/** Strip HTML tags for safe truncation */
export function stripHtmlForDisplay(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

export function ProfileCardContent({ item, profilePath, remoteProfilePath }: {
  item: ProfileItem;
  profilePath: (u: string, d?: string) => string;
  remoteProfilePath: (u: string, d: string) => string;
}) {
  const avatar = getProfileAvatar(item);
  const summary = getProfileSummary(item);
  const followers = getFollowersCount(item);
  const following = getFollowingCount(item);
  const eventsCount = getEventsCount(item);

  const stats: string[] = [];
  if (eventsCount != null) stats.push(`${eventsCount} event${eventsCount === 1 ? "" : "s"}`);
  if (followers != null) stats.push(`${followers} followers`);
  if (following != null) stats.push(`${following} following`);

  return (
    <div className="flex items-start gap-2" style={{ minWidth: 0 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: "var(--bg-hover)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.1rem",
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          {avatar.url ? (
            <img src={avatar.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            avatar.fallback
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
          <div
            style={{
              fontWeight: 600,
              lineHeight: 1.25,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {getProfileDisplayName(item)}
          </div>
          <div className="text-sm text-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {getProfileHandle(item)}
          </div>
          {summary && (
            <div
              className="text-sm text-dim mt-0.5 profile-bio"
              style={{
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                wordBreak: "break-word",
                overflowWrap: "break-word",
              }}
              title={stripHtmlForDisplay(summary).slice(0, 200)}
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(summary.replace(/\n/g, "<br>"), {
                  ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "br", "p", "span"],
                  ALLOWED_ATTR: ["href", "rel", "target"],
                }),
              }}
            />
          )}
          {stats.length > 0 && (
            <div className="text-sm text-dim" style={{ marginTop: "0.2rem" }}>
              {stats.join(" · ")}
            </div>
          )}
        </div>
      </div>
  );
}

export function FollowButton({
  followed,
  onFollow,
  onUnfollow,
  busy,
}: {
  followed: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  busy: boolean;
}) {
  return followed ? (
    <button className="btn-ghost btn-sm" onClick={onUnfollow} disabled={busy}>
      Following
    </button>
  ) : (
    <button className="btn-primary btn-sm" onClick={onFollow} disabled={busy}>
      {busy ? "…" : "Follow"}
    </button>
  );
}

export function ProfileCard({
  item,
  isFollowed,
  isOwn,
  onFollow,
  onUnfollow,
  busy,
  canFollow,
  profilePath,
  remoteProfilePath,
}: {
  item: ProfileItem;
  isFollowed: boolean;
  isOwn: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  busy: boolean;
  canFollow: boolean;
  profilePath: (u: string, d?: string) => string;
  remoteProfilePath: (u: string, d: string) => string;
}) {
  const href = getProfileHref(item, profilePath, remoteProfilePath);
  const content = <ProfileCardContent item={item} profilePath={profilePath} remoteProfilePath={remoteProfilePath} />;
  const linkWrap = (children: React.ReactNode) => (
    <Link href={href} style={{ minWidth: 0, textDecoration: "none", color: "inherit" }}>
      {children}
    </Link>
  );

  if (isOwn || !canFollow) {
    return linkWrap(content);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", alignItems: "flex-start" }}>
      {linkWrap(content)}
      <div style={{ marginLeft: "calc(40px + 1rem)" }}>
        <FollowButton followed={isFollowed} onFollow={onFollow} onUnfollow={onUnfollow} busy={busy} />
      </div>
    </div>
  );
}
