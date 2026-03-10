import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { User } from "../lib/api";
import { sanitizeHtml, stripHtmlToText } from "../lib/sanitize";
import { LinkIcon, MenuIcon, RepostIcon } from "./icons";
import { RichTextEditor } from "./RichTextEditor";

export type InlineProfileDraft = {
  displayName: string;
  bio: string;
  website: string;
  avatarUrl: string;
};

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
  canEditProfile?: boolean;
  onEditProfile?: () => void;
  editingProfile?: boolean;
  inlineDraft?: InlineProfileDraft;
  onInlineDraftChange?: (next: InlineProfileDraft) => void;
  onSaveInline?: () => void;
  onCancelInline?: () => void;
  inlineBusy?: boolean;
  inlineError?: string | null;
  hideInlineActions?: boolean;
  onInlineAvatarUpload?: (file: File) => void;
  avatarUploading?: boolean;
  onRequestExpand?: () => void;
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
  canEditProfile = false,
  onEditProfile,
  editingProfile = false,
  inlineDraft,
  onInlineDraftChange,
  onSaveInline,
  onCancelInline,
  inlineBusy = false,
  inlineError = null,
  hideInlineActions = false,
  onInlineAvatarUpload,
  avatarUploading = false,
  onRequestExpand,
}: ProfileHeaderProps) {
  const { t } = useTranslation(["profile", "common", "settings", "auth"]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bioId = useId();
  const menuId = useId();

  useEffect(() => {
    setBioExpanded(false);
  }, [profile.id, profile.bio]);

  const bioText = stripHtmlToText(profile.bio || "");
  const hasLongBio = bioText.length > 220;
  const rawBio = profile.bio || "";
  const hasHtmlTags = /<\/?[a-z][\s\S]*>/i.test(rawBio);
  const sanitizedBio = sanitizeHtml(rawBio);
  const updateDraft = (patch: Partial<InlineProfileDraft>) => {
    if (!inlineDraft || !onInlineDraftChange) return;
    onInlineDraftChange({ ...inlineDraft, ...patch });
  };

  const effectiveAvatarUrl = editingProfile && inlineDraft?.avatarUrl ? inlineDraft.avatarUrl : profile.avatarUrl;

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
      onClick={(e) => {
        if (!isMobile || collapseProgress < 0.98 || !onRequestExpand) return;
        const target = e.target as HTMLElement;
        if (target.closest("a,button,input,select,textarea,label,[role='button']")) return;
        onRequestExpand();
      }}
      style={
        isMobile
          ? {
              padding: `${0.5 + 0.5 * (1 - collapseProgress)}rem 1rem`,
              boxShadow: collapseProgress > 0.02 ? "0 1px 0 0 var(--border)" : "none",
              cursor: collapseProgress >= 0.98 ? "pointer" : undefined,
            }
          : undefined
      }
    >
      <div className="flex items-center gap-2 profile-header-inner">
        {editingProfile ? (
          <>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onInlineAvatarUpload?.(file);
                e.currentTarget.value = "";
              }}
              style={{ display: "none" }}
            />
            <button
              type="button"
              className="profile-header-avatar"
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarUploading}
              aria-label={t("profile:changeAvatar")}
              title={t("profile:changeAvatar")}
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
                border: "1px dashed var(--border)",
                cursor: avatarUploading ? "wait" : "pointer",
                padding: 0,
              }}
            >
              {effectiveAvatarUrl ? (
                <img
                  src={effectiveAvatarUrl}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                profile.username[0].toUpperCase()
              )}
            </button>
          </>
        ) : (
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
            {effectiveAvatarUrl ? (
              <img
                src={effectiveAvatarUrl}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              profile.username[0].toUpperCase()
            )}
          </div>
        )}
        <div className="flex-1">
          <div
            className="flex items-center gap-1"
            style={{
              flexWrap: "wrap",
              gap: isMobile ? `${0.5 + 0.5 * (1 - collapseProgress)}rem` : undefined,
            }}
          >
            {editingProfile && inlineDraft ? (
              <input
                value={inlineDraft.displayName}
                onChange={(e) => updateDraft({ displayName: e.target.value })}
                placeholder={t("settings:displayNamePlaceholder")}
                aria-label={t("settings:displayName")}
                style={{
                  fontSize: isMobile ? `${1.1 - 0.2 * collapseProgress}rem` : "1.05rem",
                  fontWeight: 700,
                  minWidth: 170,
                }}
              />
            ) : (
              <h1
                style={{
                  fontSize: isMobile ? `${1.3 - 0.3 * collapseProgress}rem` : "1.3rem",
                  fontWeight: 700,
                }}
              >
                {profile.displayName || profile.username}
              </h1>
            )}
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
            {editingProfile && inlineDraft ? (
              <>
                <div className="field" style={{ marginTop: "0.5rem" }}>
                  <label>{t("settings:bio")}</label>
                  <RichTextEditor
                    value={inlineDraft.bio}
                    onChange={(next) => updateDraft({ bio: next })}
                    placeholder={t("settings:bioPlaceholder")}
                  />
                </div>
                <div className="field">
                  <label>{t("settings:website")}</label>
                  <input
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={inlineDraft.website}
                    onChange={(e) => updateDraft({ website: e.target.value })}
                    placeholder={t("settings:websitePlaceholder")}
                  />
                </div>
                <p className="text-sm text-dim" style={{ marginTop: "0.35rem" }}>
                  {avatarUploading ? t("profile:uploadingAvatar") : t("profile:avatarUploadHint")}
                </p>
                <div className="flex gap-1 items-center" style={{ marginTop: "0.35rem" }}>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => updateDraft({ avatarUrl: "" })}
                    disabled={inlineBusy || avatarUploading}
                  >
                    {t("common:remove")}
                  </button>
                </div>
                {!hideInlineActions && (
                  <div className="flex gap-1 items-center" style={{ marginTop: "0.5rem" }}>
                    <button type="button" className="btn-primary btn-sm" onClick={onSaveInline} disabled={inlineBusy}>
                      {inlineBusy ? t("common:saving") : t("common:save")}
                    </button>
                    <button type="button" className="btn-ghost btn-sm" onClick={onCancelInline} disabled={inlineBusy}>
                      {t("common:cancel")}
                    </button>
                  </div>
                )}
                {inlineError && <p className="error-text mt-1" role="alert">{inlineError}</p>}
              </>
            ) : profile.bio && (
              <>
                <div
                  id={bioId}
                  className={`profile-bio mt-1${!bioExpanded && hasLongBio ? " profile-bio-collapsed" : ""}${!hasHtmlTags ? " profile-bio-plain" : ""}`}
                  dangerouslySetInnerHTML={{
                    __html: sanitizedBio,
                  }}
                />
                {hasLongBio && (
                  <button
                    type="button"
                    className="profile-bio-toggle"
                    onClick={() => setBioExpanded((expanded) => !expanded)}
                    aria-expanded={bioExpanded}
                    aria-controls={bioId}
                  >
                    {bioExpanded ? t("showLessBio") : t("showMoreBio")}
                  </button>
                )}
              </>
            )}
            {profile.website && /^https?:\/\/.+/.test(profile.website) && (
              <p className="mt-1">
                <a
                  href={profile.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: "0.35rem", overflowWrap: "anywhere" }}
                >
                  <LinkIcon />
                  {profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
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
        {currentUser && !isOwn && !canEditProfile && !editingProfile && (
          <div style={{ flexShrink: 0 }}>
            <button
              className={profile.following ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
              onClick={onFollow}
            >
              {profile.following ? t("unfollow") : t("follow")}
            </button>
          </div>
        )}
        {canEditProfile && !editingProfile && (
          <div style={{ flexShrink: 0 }}>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={onEditProfile}
            >
              {t("editProfile")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
