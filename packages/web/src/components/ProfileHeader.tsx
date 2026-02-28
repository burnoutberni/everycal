import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { User } from "../lib/api";
import { sanitizeHtmlWithNewlines } from "../lib/sanitize";
import { MenuIcon, RepostIcon } from "./icons";

export interface ProfileHeaderProps {
  profile: User;
  currentUser: User | null;
  isOwn: boolean;
  isRemote: boolean;
  /** 0 = expanded, 1 = compact. Used for mobile collapse-on-scroll. */
  collapseProgress?: number;
  isMobile?: boolean;
  headerRef?: React.RefObject<HTMLDivElement | null>;
  onFollow?: () => void;
  onAutoRepost?: () => void;
  onFollowAs?: () => void;
  onAutoRepostAs?: () => void;
  showIdentityActions?: boolean;
  onOpenFollowers?: () => void;
  onOpenFollowing?: () => void;
}

export function ProfileHeader({
  profile,
  currentUser,
  isOwn,
  isRemote,
  collapseProgress = 0,
  isMobile = false,
  headerRef,
  onFollow,
  onAutoRepost,
  onFollowAs,
  onAutoRepostAs,
  showIdentityActions = false,
  onOpenFollowers,
  onOpenFollowing,
}: ProfileHeaderProps) {
  const { t } = useTranslation(["profile", "common"]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [menuOpen]);

  return (
    <div
      ref={headerRef}
      className={`card profile-header ${isMobile ? "profile-header-mobile" : ""}`}
      style={
        isMobile
          ? {
              padding: `${0.5 + 0.5 * (1 - collapseProgress)}rem 1rem`,
              boxShadow: collapseProgress > 0.02 ? "0 1px 0 0 var(--border)" : "none",
            }
          : undefined
      }
    >
      <div className="flex items-center gap-2 profile-header-inner">
        <div
          className="profile-header-avatar"
          style={{
            width: isMobile ? 64 - 28 * collapseProgress : 64,
            height: isMobile ? 64 - 28 * collapseProgress : 64,
            borderRadius: "50%",
            background: "var(--bg-hover)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: isMobile ? `${1.8 - 0.8 * collapseProgress}rem` : "1.8rem",
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          {profile.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            profile.username[0].toUpperCase()
          )}
        </div>
        <div className="flex-1">
          <div
            className="flex items-center gap-1"
            style={{
              flexWrap: "wrap",
              gap: isMobile ? `${0.5 + 0.5 * (1 - collapseProgress)}rem` : undefined,
            }}
          >
            <h1
              style={{
                fontSize: isMobile ? `${1.3 - 0.3 * collapseProgress}rem` : "1.3rem",
                fontWeight: 700,
              }}
            >
              {profile.displayName || profile.username}
            </h1>
            {currentUser && !isOwn && (!isRemote || showIdentityActions) && (
              <div ref={menuRef} style={{ position: "relative" }}>
                <button
                  ref={menuButtonRef}
                  type="button"
                  className="profile-menu-btn"
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  aria-controls={menuOpen ? menuId : undefined}
                  aria-label={t("moreOptions")}
                  title={t("moreOptions")}
                >
                  <MenuIcon />
                </button>
                {menuOpen && (
                  <div id={menuId} className="header-dropdown" role="menu">
                    {showIdentityActions && (
                      <button
                        type="button"
                        className="header-dropdown-item"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          onFollowAs?.();
                        }}
                      >
                        {t("common:followAs")}
                      </button>
                    )}
                    {!isRemote && showIdentityActions && (
                      <button
                        type="button"
                        className="header-dropdown-item"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          onAutoRepostAs?.();
                        }}
                      >
                        {t("common:autoRepostAs")}
                      </button>
                    )}
                    {!isRemote && (
                      <button
                        type="button"
                        className="header-dropdown-item"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          onAutoRepost?.();
                        }}
                        title={profile.autoReposting ? t("stopAutoRepost") : t("autoRepostAll")}
                        style={profile.autoReposting ? { color: "var(--accent)" } : undefined}
                      >
                        <RepostIcon />
                        {profile.autoReposting ? t("autoReposting") : t("autoRepost")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <p
            className="text-muted profile-header-username"
            style={
              isMobile
                ? {
                    margin: `${0.25 * (1 - collapseProgress)}rem 0 0`,
                    fontSize: `${0.95 - 0.1 * collapseProgress}rem`,
                  }
                : undefined
            }
          >
            @{profile.username}
          </p>
          <div
            className="profile-header-details"
            style={
              isMobile
                ? {
                    maxHeight: 500 * (1 - collapseProgress),
                    opacity: 1 - collapseProgress,
                    overflow: "hidden",
                    pointerEvents: collapseProgress >= 1 ? "none" : "auto",
                  }
                : undefined
            }
          >
            {profile.bio && (
              <div
                className="profile-bio mt-1"
                dangerouslySetInnerHTML={{
                  __html: sanitizeHtmlWithNewlines(profile.bio),
                }}
              />
            )}
            {profile.website && /^https?:\/\/.+/.test(profile.website) && (
              <p className="mt-1">
                <a
                  href={profile.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  🔗 {profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              </p>
            )}
            <div className="flex gap-2 mt-1 text-sm text-muted">
              {(isOwn || isRemote) ? (
                <>
                  <button
                    type="button"
                    className="profile-stat-clickable"
                    style={{ background: "none", border: "none", color: "inherit", padding: 0, font: "inherit" }}
                    onClick={onOpenFollowers}
                  >
                    <strong style={{ color: "var(--text)" }}>{profile.followersCount}</strong> {t("followers")}
                  </button>
                  <button
                    type="button"
                    className="profile-stat-clickable"
                    style={{ background: "none", border: "none", color: "inherit", padding: 0, font: "inherit" }}
                    onClick={onOpenFollowing}
                  >
                    <strong style={{ color: "var(--text)" }}>{profile.followingCount}</strong> {t("following")}
                  </button>
                </>
              ) : (
                <>
                  <span>
                    <strong style={{ color: "var(--text)" }}>{profile.followersCount}</strong> {t("followers")}
                  </span>
                  <span>
                    <strong style={{ color: "var(--text)" }}>{profile.followingCount}</strong> {t("following")}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        {currentUser && !isOwn && (
          <div style={{ flexShrink: 0 }}>
            <button
              className={profile.following ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
              onClick={onFollow}
            >
              {profile.following ? t("unfollow") : t("follow")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
