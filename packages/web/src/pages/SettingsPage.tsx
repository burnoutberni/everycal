import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import {
  auth as authApi,
  identities as identitiesApi,
  users as usersApi,
  type User,
  type PublishingIdentity,
  type IdentityMember,
  type IdentityRole,
} from "../lib/api";
import { Link } from "wouter";
import { CitySearch, type CitySelection } from "../components/CitySearch";
import { UserIcon, LockIcon, BellIcon, KeyIcon, TrashIcon } from "../components/icons";
import { changeLanguage } from "../i18n";
import "./SettingsPage.css";

type IdentityFormErrors = {
  username?: string;
  website?: string;
  avatarUrl?: string;
};

const IDENTITY_HANDLE_PATTERN = /^[a-z0-9_]{2,40}$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
    return host.includes(".") && !host.startsWith(".") && !host.endsWith(".");
  } catch {
    return false;
  }
}

function normalizeHttpUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function SettingsPage() {
  const { t, i18n } = useTranslation(["settings", "common", "auth"]);

  const SECTIONS: { id: string; label: string; icon: React.ComponentType<{ className?: string }>; danger?: boolean }[] = [
    { id: "profile", label: t("profile"), icon: UserIcon },
    { id: "identities", label: t("publishingIdentities"), icon: UserIcon },
    { id: "account", label: t("account"), icon: LockIcon },
    { id: "notifications", label: t("notifications"), icon: BellIcon },
    { id: "api-keys", label: t("apiKeys"), icon: KeyIcon },
    { id: "danger", label: t("dangerZone"), icon: TrashIcon, danger: true },
  ];
  const { user, refreshUser } = useAuth();
  const [activeSection, setActiveSection] = useState<string>("profile");
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [website, setWebsite] = useState("");
  const [profileErrors, setProfileErrors] = useState<{ website?: string }>({});
  const [discoverable, setDiscoverable] = useState(false);
  const [city, setCity] = useState<CitySelection | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderHoursBefore, setReminderHoursBefore] = useState(24);
  const [eventUpdatedEnabled, setEventUpdatedEnabled] = useState(true);
  const [eventCancelledEnabled, setEventCancelledEnabled] = useState(true);
  const [savingNotif, setSavingNotif] = useState(false);
  const [savedNotif, setSavedNotif] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [emailChangeSent, setEmailChangeSent] = useState(false);
  const [emailChangeError, setEmailChangeError] = useState("");
  const [sendingEmailChange, setSendingEmailChange] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordChangeError, setPasswordChangeError] = useState("");
  const [passwordChangeSuccess, setPasswordChangeSuccess] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const [keys, setKeys] = useState<{ id: string; label: string; lastUsedAt: string | null; createdAt: string }[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");

  const [preferredLanguage, setPreferredLanguage] = useState<string>("en");

  const [identities, setIdentities] = useState<PublishingIdentity[]>([]);
  const [selectedIdentityUsername, setSelectedIdentityUsername] = useState("");
  const [identityMembers, setIdentityMembers] = useState<IdentityMember[]>([]);
  const [identityError, setIdentityError] = useState("");
  const [identityBusy, setIdentityBusy] = useState(false);
  const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
  const [identityEditorOpen, setIdentityEditorOpen] = useState<"create" | "edit" | null>(null);
  const [editIdentityDraft, setEditIdentityDraft] = useState<PublishingIdentity | null>(null);
  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [createIdentityUsername, setCreateIdentityUsername] = useState("");
  const [createIdentityDisplayName, setCreateIdentityDisplayName] = useState("");
  const [createIdentityBio, setCreateIdentityBio] = useState("");
  const [createIdentityWebsite, setCreateIdentityWebsite] = useState("");
  const [createIdentityAvatarUrl, setCreateIdentityAvatarUrl] = useState("");
  const [createIdentityErrors, setCreateIdentityErrors] = useState<IdentityFormErrors>({});
  const [createIdentityDiscoverable, setCreateIdentityDiscoverable] = useState(true);
  const [createIdentityDefaultVisibility, setCreateIdentityDefaultVisibility] = useState<"public" | "unlisted" | "followers_only" | "private">("public");
  const [createIdentityCity, setCreateIdentityCity] = useState<CitySelection | null>(null);
  const [createIdentityPreferredLanguage, setCreateIdentityPreferredLanguage] = useState<"en" | "de">("en");
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<IdentityRole>("editor");
  const [memberSuggestions, setMemberSuggestions] = useState<User[]>([]);
  const [memberLookupBusy, setMemberLookupBusy] = useState(false);
  const [showMemberSuggestions, setShowMemberSuggestions] = useState(false);
  const [editIdentityErrors, setEditIdentityErrors] = useState<Omit<IdentityFormErrors, "username">>({});
  const memberResultsRef = useRef<HTMLDivElement | null>(null);
  const skipNextMemberLookupRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    authApi.me().then((u) => {
      setDisplayName(u.displayName || "");
      setBio(u.bio || "");
      setWebsite(u.website || "");
      setDiscoverable(!!u.discoverable);
      setPreferredLanguage(u.preferredLanguage || "en");
      if (u.city && u.cityLat != null && u.cityLng != null) {
        setCity({ city: u.city, lat: u.cityLat, lng: u.cityLng });
      }
      const p = u.notificationPrefs;
      if (p) {
        setReminderEnabled(p.reminderEnabled);
        setReminderHoursBefore(p.reminderHoursBefore);
        setEventUpdatedEnabled(p.eventUpdatedEnabled);
        setEventCancelledEnabled(p.eventCancelledEnabled);
      }
    });
    authApi.listApiKeys().then((r) => setKeys(r.keys));
    identitiesApi.list().then((res) => {
      const scoped = res.identities.filter((identity) => identity.accountType === "identity");
      setIdentities(scoped);
      if (!selectedIdentityUsername && scoped.length > 0) {
        setSelectedIdentityUsername(scoped[0].username);
      }
    }).catch(() => {
      setIdentities([]);
    });
  }, [user]);

  const roleRank: Record<IdentityRole, number> = { editor: 1, admin: 2, owner: 3 };
  const visibilityOptions: Array<{ value: "public" | "unlisted" | "followers_only" | "private"; label: string }> = [
    { value: "public", label: t("visibility.public") },
    { value: "unlisted", label: t("visibility.unlisted") },
    { value: "followers_only", label: t("visibility.followersOnly") },
    { value: "private", label: t("visibility.private") },
  ];
  const languageOptions: Array<{ value: "en" | "de"; label: string }> = [
    { value: "en", label: t("english") },
    { value: "de", label: t("german") },
  ];

  const normalizeAndValidateUrl = (value: string, errorKey: "invalidWebsiteUrl" | "invalidAvatarUrl") => {
    const normalized = normalizeHttpUrlInput(value);
    if (!normalized) return { normalized: "", error: undefined as string | undefined };
    if (!isValidHttpUrl(normalized)) return { normalized, error: t(errorKey) };
    return { normalized, error: undefined as string | undefined };
  };

  const validateWebsite = (value: string): { normalized: string; error?: string } =>
    normalizeAndValidateUrl(value, "invalidWebsiteUrl");

  const validateAvatarUrl = (value: string): { normalized: string; error?: string } =>
    normalizeAndValidateUrl(value, "invalidAvatarUrl");

  const validateIdentityHandle = (value: string): string | undefined => {
    const normalized = value.toLowerCase().trim();
    if (!normalized) return t("identityHandleRequired");
    if (normalized.includes("@") || /\s/.test(normalized) || !IDENTITY_HANDLE_PATTERN.test(normalized)) {
      return t("invalidIdentityHandle");
    }
    return undefined;
  };

  const validateIdentityForm = (
    values: { username?: string; website?: string; avatarUrl?: string },
    requireUsername: boolean
  ): IdentityFormErrors => {
    const errors: IdentityFormErrors = {};
    if (requireUsername) {
      const handleError = validateIdentityHandle(values.username || "");
      if (handleError) errors.username = handleError;
    }
    const websiteResult = validateWebsite(values.website || "");
    if (websiteResult.error) errors.website = websiteResult.error;
    const avatarResult = validateAvatarUrl(values.avatarUrl || "");
    if (avatarResult.error) errors.avatarUrl = avatarResult.error;
    return errors;
  };

  const hasErrors = (errors: Record<string, string | undefined>): boolean =>
    Object.values(errors).some(Boolean);

  const selectedIdentity = identities.find((identity) => identity.username === selectedIdentityUsername) || null;
  const selectedRole = selectedIdentity?.role;
  const canAdminMembers = !!selectedRole && roleRank[selectedRole] >= roleRank.admin;
  const isOwner = selectedRole === "owner";

  useEffect(() => {
    if (!selectedIdentity) {
      setIdentityMembers([]);
      return;
    }
    identitiesApi
      .listMembers(selectedIdentity.username)
      .then((res) => setIdentityMembers(res.members))
      .catch(() => setIdentityMembers([]));
  }, [selectedIdentity?.username]);

  useEffect(() => {
    if (!membersModalOpen || !showMemberSuggestions) return;
    if (skipNextMemberLookupRef.current) {
      skipNextMemberLookupRef.current = false;
      return;
    }
    const q = inviteUsername.trim();
    if (q.length < 2) {
      setMemberSuggestions([]);
      setMemberLookupBusy(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setMemberLookupBusy(true);
      try {
        const res = await usersApi.list({ q, limit: 8 });
        if (cancelled) return;
        const existing = new Set(identityMembers.map((member) => member.username));
        setMemberSuggestions(
          res.users.filter(
            (candidate) =>
              candidate.accountType !== "identity"
              && candidate.username !== selectedIdentity?.username
              && !existing.has(candidate.username)
          )
        );
      } catch {
        if (!cancelled) setMemberSuggestions([]);
      } finally {
        if (!cancelled) setMemberLookupBusy(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inviteUsername, membersModalOpen, showMemberSuggestions, identityMembers, selectedIdentity?.username]);

  useEffect(() => {
    if (!membersModalOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (memberResultsRef.current && !memberResultsRef.current.contains(e.target as Node)) {
        setShowMemberSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [membersModalOpen]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 }
    );
    SECTIONS.forEach(({ id }) => {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [user]);

  const scrollToSection = (id: string) => {
    const el = sectionRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveSection(id);
    }
  };

  if (!user) {
    return (
      <div className="empty-state mt-3">
        <p>
          <Link href="/login">{t("common:logIn")}</Link> {t("logInToAccess")}
        </p>
      </div>
    );
  }

  const handleLanguageChange = async (locale: "en" | "de") => {
    setPreferredLanguage(locale);
    changeLanguage(locale);
    try {
      await authApi.updateProfile({ preferredLanguage: locale });
    } catch {
      // ignore
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const websiteResult = validateWebsite(website);
    const normalizedWebsite = websiteResult.normalized;
    const nextErrors = { website: websiteResult.error };
    setProfileErrors(nextErrors);
    setWebsite(normalizedWebsite);
    if (hasErrors(nextErrors)) return;

    setSaving(true);
    setSaved(false);
    try {
      await authApi.updateProfile({
        displayName,
        bio,
        website: normalizedWebsite,
        discoverable,
        preferredLanguage: preferredLanguage as "en" | "de",
        ...(city ? { city: city.city, cityLat: city.lat, cityLng: city.lng } : {}),
      });
      await refreshUser();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyLabel) return;
    const result = await authApi.createApiKey(newKeyLabel);
    setNewKeyValue(result.key);
    setNewKeyLabel("");
    authApi.listApiKeys().then((r) => setKeys(r.keys));
  };

  const handleCreateIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    setIdentityError("");
    const normalizedUsername = createIdentityUsername.toLowerCase().trim();
    const websiteResult = validateWebsite(createIdentityWebsite);
    const avatarResult = validateAvatarUrl(createIdentityAvatarUrl);
    const normalizedWebsite = websiteResult.normalized;
    const normalizedAvatarUrl = avatarResult.normalized;
    const nextErrors = validateIdentityForm(
      { username: normalizedUsername, website: normalizedWebsite, avatarUrl: normalizedAvatarUrl },
      true
    );
    setCreateIdentityUsername(normalizedUsername);
    setCreateIdentityWebsite(normalizedWebsite);
    setCreateIdentityAvatarUrl(normalizedAvatarUrl);
    setCreateIdentityErrors(nextErrors);
    if (hasErrors(nextErrors)) return;

    setIdentityBusy(true);
    try {
      await identitiesApi.create({
        username: normalizedUsername,
        displayName: createIdentityDisplayName || undefined,
        bio: createIdentityBio || undefined,
        website: normalizedWebsite || undefined,
        avatarUrl: normalizedAvatarUrl || undefined,
        discoverable: createIdentityDiscoverable,
        defaultVisibility: createIdentityDefaultVisibility,
        ...(createIdentityCity ? {
          city: createIdentityCity.city,
          cityLat: createIdentityCity.lat,
          cityLng: createIdentityCity.lng,
        } : {}),
        preferredLanguage: createIdentityPreferredLanguage,
      });
      const res = await identitiesApi.list();
      const scoped = res.identities.filter((identity) => identity.accountType === "identity");
      setIdentities(scoped);
      const created = scoped.find((identity) => identity.username === createIdentityUsername.toLowerCase().trim());
      if (created) setSelectedIdentityUsername(created.username);
      closeIdentityEditorModal();
      setCreateIdentityUsername("");
      setCreateIdentityDisplayName("");
      setCreateIdentityBio("");
      setCreateIdentityWebsite("");
      setCreateIdentityAvatarUrl("");
      setCreateIdentityDiscoverable(true);
      setCreateIdentityDefaultVisibility("public");
      setCreateIdentityCity(null);
      setCreateIdentityPreferredLanguage(preferredLanguage === "de" ? "de" : "en");
      setCreateIdentityErrors({});
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setIdentityBusy(false);
    }
  };

  const handleSaveIdentityProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editIdentityDraft) return;
    setIdentityError("");
    const websiteResult = validateWebsite(editIdentityDraft.website || "");
    const avatarResult = validateAvatarUrl(editIdentityDraft.avatarUrl || "");
    const normalizedWebsite = websiteResult.normalized;
    const normalizedAvatarUrl = avatarResult.normalized;
    const nextErrors = validateIdentityForm(
      { website: normalizedWebsite, avatarUrl: normalizedAvatarUrl },
      false
    );
    setEditIdentityErrors(nextErrors);
    if (hasErrors(nextErrors)) return;

    setIdentityBusy(true);
    try {
      const res = await identitiesApi.update(editIdentityDraft.username, {
        displayName: editIdentityDraft.displayName || undefined,
        bio: editIdentityDraft.bio || undefined,
        website: normalizedWebsite || null,
        avatarUrl: normalizedAvatarUrl || null,
        discoverable: editIdentityDraft.discoverable,
        defaultVisibility: editIdentityDraft.defaultVisibility,
        ...(editIdentityDraft.city && editIdentityDraft.cityLat != null && editIdentityDraft.cityLng != null
          ? {
              city: editIdentityDraft.city,
              cityLat: editIdentityDraft.cityLat,
              cityLng: editIdentityDraft.cityLng,
            }
          : {}),
        preferredLanguage: editIdentityDraft.preferredLanguage,
      });
      setIdentities((prev) => prev.map((identity) => (
        identity.username === editIdentityDraft.username ? res.identity : identity
      )));
      closeIdentityEditorModal();
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setIdentityBusy(false);
    }
  };

  const handleDeleteIdentity = async (username: string) => {
    if (!confirm(t("deleteIdentityConfirm", { username }))) return;
    setIdentityError("");
    try {
      await identitiesApi.delete(username);
      const res = await identitiesApi.list();
      const scoped = res.identities.filter((identity) => identity.accountType === "identity");
      setIdentities(scoped);
      setSelectedIdentityUsername((current) => (current === username ? (scoped[0]?.username || "") : current));
      closeIdentityEditorModal();
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    }
  };

  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIdentity) return;
    setIdentityError("");
    setIdentityBusy(true);
    try {
      await identitiesApi.addMember(selectedIdentity.username, inviteUsername, inviteRole);
      const res = await identitiesApi.listMembers(selectedIdentity.username);
      setIdentityMembers(res.members);
      setInviteUsername("");
      setInviteRole("editor");
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setIdentityBusy(false);
    }
  };

  const handleUpdateMemberRole = async (memberId: string, role: IdentityRole) => {
    if (!selectedIdentity) return;
    setIdentityError("");
    setMemberBusyId(memberId);
    try {
      await identitiesApi.updateMember(selectedIdentity.username, memberId, role);
      const res = await identitiesApi.listMembers(selectedIdentity.username);
      setIdentityMembers(res.members);
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setMemberBusyId(null);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!selectedIdentity) return;
    if (!confirm(t("removeMemberConfirm"))) return;
    setIdentityError("");
    setMemberBusyId(memberId);
    try {
      await identitiesApi.removeMember(selectedIdentity.username, memberId);
      setIdentityMembers((prev) => prev.filter((member) => member.memberId !== memberId));
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setMemberBusyId(null);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordChangeError("");
    setPasswordChangeSuccess(false);
    if (newPassword !== confirmPassword) {
      setPasswordChangeError(t("passwordsDoNotMatch"));
      return;
    }
    if (newPassword.length < 8) {
      setPasswordChangeError(t("passwordMinLength"));
      return;
    }
    setChangingPassword(true);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      setPasswordChangeSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordChangeSuccess(false), 3000);
    } catch (err: unknown) {
      setPasswordChangeError((err as Error).message || t("failedChangePassword"));
    } finally {
      setChangingPassword(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!confirm(t("deleteKeyConfirm"))) return;
    await authApi.deleteApiKey(id);
    setKeys(keys.filter((k) => k.id !== id));
  };

  const handleDeleteAccount = async () => {
    if (!confirm(t("deleteAccountConfirm"))) {
      return;
    }
    const username = prompt(t("typeUsernameToConfirm", { username: user.username }));
    if (username !== user.username) {
      alert(t("usernameDoesNotMatch"));
      return;
    }
    try {
      await authApi.deleteAccount();
      window.location.href = "/";
    } catch {
      alert(t("failedDeleteAccount"));
    }
  };

  const closeIdentityEditorModal = () => {
    setIdentityEditorOpen(null);
    setEditIdentityDraft(null);
    setCreateIdentityErrors({});
    setEditIdentityErrors({});
    setIdentityError("");
  };

  const openCreateIdentityModal = () => {
    setIdentityError("");
    setCreateIdentityErrors({});
    setEditIdentityErrors({});
    setEditIdentityDraft(null);
    setCreateIdentityUsername("");
    setCreateIdentityDisplayName("");
    setCreateIdentityBio("");
    setCreateIdentityWebsite("");
    setCreateIdentityAvatarUrl("");
    setCreateIdentityDiscoverable(true);
    setCreateIdentityDefaultVisibility("public");
    setCreateIdentityCity(city ? { city: city.city, lat: city.lat, lng: city.lng } : null);
    setCreateIdentityPreferredLanguage(preferredLanguage === "de" ? "de" : "en");
    setIdentityEditorOpen("create");
  };

  const openEditIdentityModal = (username: string) => {
    const identity = identities.find((candidate) => candidate.username === username);
    if (!identity) return;
    setIdentityError("");
    setEditIdentityErrors({});
    setCreateIdentityErrors({});
    setSelectedIdentityUsername(username);
    setEditIdentityDraft({ ...identity });
    setIdentityEditorOpen("edit");
  };

  const openMembersModal = (username: string) => {
    setIdentityError("");
    setInviteUsername("");
    setInviteRole("editor");
    setMemberSuggestions([]);
    setShowMemberSuggestions(false);
    setMemberLookupBusy(false);
    setSelectedIdentityUsername(username);
    setMembersModalOpen(true);
  };

  return (
    <div className="settings-layout">
      <aside className="settings-sidebar">
        <nav className="settings-nav" aria-label={t("settingsSections")}>
          {SECTIONS.map(({ id, label, icon: Icon, danger }) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-link ${danger ? "danger" : ""} ${activeSection === id ? "active" : ""}`}
              onClick={() => scrollToSection(id)}
            >
              <Icon />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings-content">
        <h1 className="settings-page-title">{t("title")}</h1>

        <section
          id="profile"
          ref={(el) => { sectionRefs.current.profile = el; }}
          className="settings-section"
          aria-labelledby="profile-heading"
        >
          <div className="settings-card">
            <h2 id="profile-heading" className="settings-section-title">
              {t("profile")}
            </h2>
            <form onSubmit={handleSaveProfile}>
              <div className="field">
                <label htmlFor="displayName">{t("displayName")}</label>
                <input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t("displayNamePlaceholder")}
                />
              </div>
              <div className="field">
                <label htmlFor="bio">{t("bio")}</label>
                <textarea
                  id="bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  placeholder={t("bioPlaceholder")}
                />
              </div>
              <div className="field">
                <label htmlFor="website">{t("website")}</label>
                <input
                  id="website"
                  type="url"
                  value={website}
                  onChange={(e) => {
                    setWebsite(e.target.value);
                    setProfileErrors((prev) => ({ ...prev, website: undefined }));
                  }}
                  onBlur={() => {
                    const result = validateWebsite(website);
                    setWebsite(result.normalized);
                    setProfileErrors((prev) => ({ ...prev, website: result.error }));
                  }}
                  placeholder={t("websitePlaceholder")}
                />
                {profileErrors.website && <p className="text-sm mt-1 error-text">{profileErrors.website}</p>}
              </div>
              <div className="field">
                <label htmlFor="city">{t("city")}</label>
                <CitySearch id="city" value={city} onChange={setCity} placeholder={t("auth:whereBased")} />
              </div>
              <div className="field">
                <label htmlFor="language">{t("language")}</label>
                <select
                  id="language"
                  value={preferredLanguage}
                  onChange={(e) => handleLanguageChange(e.target.value as "en" | "de")}
                  className="field-input"
                  style={{ maxWidth: 200 }}
                >
                  {languageOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={discoverable}
                    onChange={(e) => setDiscoverable(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  {t("publicAccount")}
                </label>
                <p className="text-sm text-dim mt-1">
                  {discoverable ? t("publicAccountDescVisible") : t("publicAccountDescHidden")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button type="submit" className="btn-primary btn-sm" disabled={saving}>
                  {saving ? t("common:saving") : t("common:save")}
                </button>
                {saved && <span className="text-sm" style={{ color: "var(--success)" }}>{t("common:saved")}</span>}
              </div>
            </form>
          </div>
        </section>

        <section
          id="identities"
          ref={(el) => { sectionRefs.current.identities = el; }}
          className="settings-section"
          aria-labelledby="identities-heading"
        >
          <div className="settings-card">
            <h2 id="identities-heading" className="settings-section-title">
              {t("publishingIdentities")}
            </h2>
            <p className="text-sm text-dim mb-2">{t("publishingIdentitiesHelp")}</p>

            {identities.length === 0 ? (
              <p className="text-sm text-dim mb-2">{t("noPublishingIdentities")}</p>
            ) : (
              <div className="identity-list">
                {identities.map((identity) => (
                  <article
                    key={identity.id}
                    className={`identity-card ${identity.username === selectedIdentityUsername ? "identity-card-selected" : ""}`}
                  >
                    <div className="identity-card-header">
                      <div>
                        <p className="identity-card-title">{identity.displayName || identity.username}</p>
                        <p className="identity-card-handle">@{identity.username}</p>
                      </div>
                      <span className="identity-role-chip">{t(`role.${identity.role}`)}</span>
                    </div>
                    <div className="identity-card-meta">
                      <span>{t("defaultEventVisibility")}: {t(`visibility.${identity.defaultVisibility === "followers_only" ? "followersOnly" : identity.defaultVisibility}`)}</span>
                      <span>{t("language")}: {languageOptions.find((option) => option.value === identity.preferredLanguage)?.label || identity.preferredLanguage}</span>
                      <span>{t("city")}: {identity.city || "-"}</span>
                      <span>{identity.discoverable ? t("identityDiscoverableYes") : t("identityDiscoverableNo")}</span>
                    </div>
                    <div className="identity-card-actions">
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => openEditIdentityModal(identity.username)}
                        disabled={roleRank[identity.role] < roleRank.admin}
                      >
                        {t("editIdentity")}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => openMembersModal(identity.username)}
                        disabled={roleRank[identity.role] < roleRank.admin}
                      >
                        {t("manageMembers")}
                      </button>
                      {identity.role === "owner" && (
                        <button
                          type="button"
                          className="btn-danger btn-sm"
                          onClick={() => handleDeleteIdentity(identity.username)}
                        >
                          {t("deleteIdentity")}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}

            <button type="button" className="btn-primary btn-sm" onClick={openCreateIdentityModal}>
              {t("createPublishingIdentity")}
            </button>
          </div>
        </section>

        <section
          id="account"
          ref={(el) => { sectionRefs.current.account = el; }}
          className="settings-section"
          aria-labelledby="account-heading"
        >
          <div className="settings-card">
            <h2 id="account-heading" className="settings-section-title">
              {t("account")}
            </h2>
            <p className="text-sm text-dim mb-2">{t("emailLabel")}: {user.email || "—"}</p>
            <div className="field mb-2">
              <label htmlFor="email">{t("emailChange")}</label>
              <div className="flex gap-1 items-center" style={{ flexWrap: "wrap" }}>
                <input
                  id="email"
                  type="email"
                  value={newEmail}
                  onChange={(e) => {
                    setNewEmail(e.target.value);
                    setEmailChangeError("");
                    setEmailChangeSent(false);
                  }}
                  placeholder={user.email || t("emailPlaceholder")}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={!newEmail.trim() || sendingEmailChange}
                  onClick={async () => {
                    setSendingEmailChange(true);
                    setEmailChangeError("");
                    setEmailChangeSent(false);
                    try {
                      await authApi.requestEmailChange(newEmail.trim());
                      setEmailChangeSent(true);
                      setNewEmail("");
                    } catch (err: unknown) {
                      setEmailChangeError((err as Error).message || t("failedSendVerification"));
                    } finally {
                      setSendingEmailChange(false);
                    }
                  }}
                >
                  {sendingEmailChange ? t("sending") : t("sendVerificationLink")}
                </button>
              </div>
              {emailChangeSent && (
                <p className="text-sm mt-1" style={{ color: "var(--success)" }}>
                  {t("checkInboxVerify")}
                </p>
              )}
              {emailChangeError && <p className="text-sm mt-1 error-text">{emailChangeError}</p>}
            </div>

            <form onSubmit={handleChangePassword} className="mt-3" style={{ paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
              <h3 className="text-sm font-medium mb-2" style={{ color: "var(--text-muted)" }}>{t("passwordChange")}</h3>
              <div className="field">
                <label htmlFor="currentPassword">{t("currentPassword")}</label>
                <input
                  id="currentPassword"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => { setCurrentPassword(e.target.value); setPasswordChangeError(""); }}
                  autoComplete="current-password"
                />
              </div>
              <div className="field">
                <label htmlFor="newPassword">{t("newPassword")}</label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setPasswordChangeError(""); }}
                  autoComplete="new-password"
                />
              </div>
              <div className="field">
                <label htmlFor="confirmPassword">{t("confirmNewPassword")}</label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setPasswordChangeError(""); }}
                  autoComplete="new-password"
                />
              </div>
              {passwordChangeError && <p className="text-sm mt-1 error-text">{passwordChangeError}</p>}
              {passwordChangeSuccess && <p className="text-sm mt-1" style={{ color: "var(--success)" }}>{t("passwordUpdated")}</p>}
              <div className="flex items-center gap-1 mt-1">
                <button type="submit" className="btn-primary btn-sm" disabled={changingPassword}>
                  {changingPassword ? t("changing") : t("changePassword")}
                </button>
              </div>
            </form>
          </div>
        </section>

        <section
          id="notifications"
          ref={(el) => { sectionRefs.current.notifications = el; }}
          className="settings-section"
          aria-labelledby="notifications-heading"
        >
          <div className="settings-card">
            <h2 id="notifications-heading" className="settings-section-title">
              {t("notifications")}
            </h2>
            {user.email ? (
              <p className="text-sm text-dim mb-2">{t("emailLabel")}: {user.email}</p>
            ) : (
              <p className="text-sm mb-2" style={{ color: "var(--warning)" }}>
                {t("addEmailForNotifications")}
              </p>
            )}
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setSavingNotif(true);
                setSavedNotif(false);
                try {
                  await authApi.updateNotificationPrefs({
                    reminderEnabled,
                    reminderHoursBefore,
                    eventUpdatedEnabled,
                    eventCancelledEnabled,
                  });
                  await refreshUser();
                  setSavedNotif(true);
                  setTimeout(() => setSavedNotif(false), 2000);
                } finally {
                  setSavingNotif(false);
                }
              }}
            >
              <div className="field">
                <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={reminderEnabled}
                    onChange={(e) => setReminderEnabled(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  {t("sendReminderBefore")}
                </label>
                {reminderEnabled && (
                  <div className="settings-reminder-select-wrap">
                    <select
                      value={reminderHoursBefore}
                      onChange={(e) => setReminderHoursBefore(Number(e.target.value))}
                    >
                      <option value={1}>{t("hourBefore1")}</option>
                      <option value={6}>{t("hourBefore6")}</option>
                      <option value={12}>{t("hourBefore12")}</option>
                      <option value={24}>{t("hourBefore24")}</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="field">
                <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={eventUpdatedEnabled}
                    onChange={(e) => setEventUpdatedEnabled(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  {t("whenEventUpdated")}
                </label>
              </div>
              <div className="field">
                <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={eventCancelledEnabled}
                    onChange={(e) => setEventCancelledEnabled(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  {t("whenEventCancelled")}
                </label>
              </div>
              {!reminderEnabled && !eventUpdatedEnabled && !eventCancelledEnabled && (
                <p className="text-sm mb-2" style={{ color: "var(--warning)" }}>
                  {t("noNotificationsWarning")}{" "}
                  <Link href="/calendar">{t("calendarFeed")}</Link> {t("noNotificationsWarningSuffix")}
                </p>
              )}
              <div className="flex items-center gap-1">
                <button type="submit" className="btn-primary btn-sm" disabled={savingNotif}>
                  {savingNotif ? t("common:saving") : t("common:save")}
                </button>
                {savedNotif && <span className="text-sm" style={{ color: "var(--success)" }}>{t("common:saved")}</span>}
              </div>
            </form>
          </div>
        </section>

        <section
          id="api-keys"
          ref={(el) => { sectionRefs.current["api-keys"] = el; }}
          className="settings-section"
          aria-labelledby="api-keys-heading"
        >
          <div className="settings-card">
            <h2 id="api-keys-heading" className="settings-section-title">
              {t("apiKeys")}
            </h2>
            <p className="text-sm text-muted mb-2">
              {t("apiKeysHelp")}{" "}
              <code className="settings-code">{t("apiKeyHeaderExample")}</code>
            </p>

            {newKeyValue && (
              <div className="settings-new-key-banner">
                <p className="text-sm" style={{ color: "var(--success)", fontWeight: 600 }}>
                  {t("newKeyCreated")}
                </p>
                <code className="settings-code-block">{newKeyValue}</code>
                <div className="flex gap-1 mt-1">
                  <button className="btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(newKeyValue)}>
                    {t("common:copy")}
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setNewKeyValue("")}>
                    {t("common:dismiss")}
                  </button>
                </div>
              </div>
            )}

            {keys.length > 0 && (
              <div className="settings-keys-list">
                {keys.map((k) => (
                  <div key={k.id} className="settings-key-row">
                    <div>
                      <span style={{ fontWeight: 500 }}>{k.label}</span>
                      <span className="text-sm text-dim" style={{ marginLeft: "0.5rem" }}>
                        {t("keyCreated")} {new Date(k.createdAt).toLocaleDateString(i18n.language)}
                        {k.lastUsedAt && ` · ${t("keyLastUsed")} ${new Date(k.lastUsedAt).toLocaleDateString(i18n.language)}`}
                      </span>
                    </div>
                    <button className="btn-danger btn-sm" onClick={() => handleDeleteKey(k.id)}>
                      {t("common:delete")}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-1 items-center">
              <input
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                placeholder={t("keyLabelPlaceholder")}
                style={{ flex: 1 }}
              />
              <button className="btn-ghost btn-sm" onClick={handleCreateKey} disabled={!newKeyLabel}>
                {t("createKey")}
              </button>
            </div>
          </div>
        </section>

        <section
          id="danger"
          ref={(el) => { sectionRefs.current.danger = el; }}
          className="settings-section danger"
          aria-labelledby="danger-heading"
        >
          <div className="settings-card danger-card">
            <h2 id="danger-heading" className="settings-section-title">
              {t("dangerZone")}
            </h2>
            <p className="text-sm text-muted mb-2">
              {t("deleteAccountWarning")}
            </p>
            <button className="btn-danger" onClick={handleDeleteAccount}>
              {t("deleteAccount")}
            </button>
          </div>
        </section>
      </div>

      {identityEditorOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && closeIdentityEditorModal()}
        >
          <div className="modal-card settings-identity-modal-card">
            <div className="modal-header">
              <h3 className="settings-section-title" style={{ margin: 0 }}>
                {identityEditorOpen === "create"
                  ? t("createPublishingIdentity")
                  : `${t("identityProfile")}: @${editIdentityDraft?.username || selectedIdentity?.username || ""}`}
              </h3>
              <button type="button" className="btn-ghost btn-sm" onClick={closeIdentityEditorModal}>
                {t("common:close")}
              </button>
            </div>
            <div className="modal-body settings-identity-modal-body">
              {identityEditorOpen === "create" ? (
                <form onSubmit={handleCreateIdentity}>
                  <div className="field">
                    <label>{t("identityHandle")}</label>
                    <div className="prefixed-input">
                      <span className="prefixed-input-prefix" aria-hidden="true">@</span>
                      <input
                        value={createIdentityUsername}
                        onChange={(e) => {
                          setCreateIdentityUsername(e.target.value);
                          setCreateIdentityErrors((prev) => ({ ...prev, username: undefined }));
                        }}
                        onBlur={() => {
                          const normalized = createIdentityUsername.toLowerCase().trim();
                          setCreateIdentityUsername(normalized);
                          setCreateIdentityErrors((prev) => ({ ...prev, username: validateIdentityHandle(normalized) }));
                        }}
                        placeholder={t("usernamePlaceholder")}
                        required
                      />
                    </div>
                    {createIdentityErrors.username && <p className="text-sm mt-1 error-text">{createIdentityErrors.username}</p>}
                </div>
                <div className="field">
                  <label>{t("displayName")}</label>
                  <input
                    value={createIdentityDisplayName}
                    onChange={(e) => setCreateIdentityDisplayName(e.target.value)}
                    placeholder={t("displayNamePlaceholder")}
                  />
                </div>
                <div className="field">
                  <label>{t("bio")}</label>
                  <textarea
                    rows={3}
                    value={createIdentityBio}
                    onChange={(e) => setCreateIdentityBio(e.target.value)}
                    placeholder={t("bioPlaceholder")}
                  />
                </div>
                <div className="field">
                  <label>{t("website")}</label>
                  <input
                    type="url"
                    value={createIdentityWebsite}
                    onChange={(e) => {
                      setCreateIdentityWebsite(e.target.value);
                      setCreateIdentityErrors((prev) => ({ ...prev, website: undefined }));
                    }}
                    onBlur={() => {
                      const result = validateWebsite(createIdentityWebsite);
                      setCreateIdentityWebsite(result.normalized);
                      setCreateIdentityErrors((prev) => ({ ...prev, website: result.error }));
                    }}
                    placeholder={t("websitePlaceholder")}
                  />
                  {createIdentityErrors.website && <p className="text-sm mt-1 error-text">{createIdentityErrors.website}</p>}
                </div>
                <div className="field">
                  <label>{t("avatarUrl")}</label>
                  <input
                    type="url"
                    value={createIdentityAvatarUrl}
                    onChange={(e) => {
                      setCreateIdentityAvatarUrl(e.target.value);
                      setCreateIdentityErrors((prev) => ({ ...prev, avatarUrl: undefined }));
                    }}
                    onBlur={() => {
                      const result = validateAvatarUrl(createIdentityAvatarUrl);
                      setCreateIdentityAvatarUrl(result.normalized);
                      setCreateIdentityErrors((prev) => ({ ...prev, avatarUrl: result.error }));
                    }}
                    placeholder={t("avatarUrlPlaceholder")}
                  />
                  {createIdentityErrors.avatarUrl && <p className="text-sm mt-1 error-text">{createIdentityErrors.avatarUrl}</p>}
                </div>
                <div className="field">
                  <label>{t("city")}</label>
                  <CitySearch
                    value={createIdentityCity}
                    onChange={setCreateIdentityCity}
                    placeholder={t("auth:whereBased")}
                  />
                </div>
                <div className="field">
                  <label>{t("language")}</label>
                  <select
                    value={createIdentityPreferredLanguage}
                    onChange={(e) => setCreateIdentityPreferredLanguage(e.target.value as "en" | "de")}
                  >
                    {languageOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                  <div className="field">
                    <label>{t("defaultEventVisibility")}</label>
                    <select
                      value={createIdentityDefaultVisibility}
                      onChange={(e) => setCreateIdentityDefaultVisibility(e.target.value as "public" | "unlisted" | "followers_only" | "private")}
                    >
                      {visibilityOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={createIdentityDiscoverable}
                        onChange={(e) => setCreateIdentityDiscoverable(e.target.checked)}
                        style={{ width: "auto" }}
                      />
                      {t("discoverableIdentity")}
                    </label>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="submit" className="btn-primary btn-sm" disabled={identityBusy}>
                      {identityBusy ? t("common:saving") : t("createIdentity")}
                    </button>
                  </div>
                  {identityError && <p className="text-sm mt-1 error-text">{identityError}</p>}
                </form>
              ) : editIdentityDraft ? (
                <form onSubmit={handleSaveIdentityProfile}>
                  <div className="field">
                    <label>{t("displayName")}</label>
                    <input
                      value={editIdentityDraft.displayName || ""}
                      onChange={(e) => setEditIdentityDraft((prev) => (prev ? { ...prev, displayName: e.target.value } : prev))}
                      placeholder={t("displayNamePlaceholder")}
                    />
                  </div>
                  <div className="field">
                    <label>{t("bio")}</label>
                    <textarea
                      rows={3}
                      value={editIdentityDraft.bio || ""}
                      onChange={(e) => setEditIdentityDraft((prev) => (prev ? { ...prev, bio: e.target.value } : prev))}
                      placeholder={t("bioPlaceholder")}
                    />
                  </div>
                  <div className="field">
                    <label>{t("website")}</label>
                    <input
                      type="url"
                      value={editIdentityDraft.website || ""}
                      onChange={(e) => {
                        setEditIdentityDraft((prev) => (prev ? { ...prev, website: e.target.value } : prev));
                        setEditIdentityErrors((prev) => ({ ...prev, website: undefined }));
                      }}
                      onBlur={() => {
                        const result = validateWebsite(editIdentityDraft.website || "");
                        setEditIdentityDraft((prev) => (prev ? { ...prev, website: result.normalized || null } : prev));
                        setEditIdentityErrors((prev) => ({ ...prev, website: result.error }));
                      }}
                      placeholder={t("websitePlaceholder")}
                    />
                    {editIdentityErrors.website && <p className="text-sm mt-1 error-text">{editIdentityErrors.website}</p>}
                  </div>
                  <div className="field">
                    <label>{t("avatarUrl")}</label>
                    <input
                      type="url"
                      value={editIdentityDraft.avatarUrl || ""}
                      onChange={(e) => {
                        setEditIdentityDraft((prev) => (prev ? { ...prev, avatarUrl: e.target.value } : prev));
                        setEditIdentityErrors((prev) => ({ ...prev, avatarUrl: undefined }));
                      }}
                      onBlur={() => {
                        const result = validateAvatarUrl(editIdentityDraft.avatarUrl || "");
                        setEditIdentityDraft((prev) => (prev ? { ...prev, avatarUrl: result.normalized || null } : prev));
                        setEditIdentityErrors((prev) => ({ ...prev, avatarUrl: result.error }));
                      }}
                      placeholder={t("avatarUrlPlaceholder")}
                    />
                    {editIdentityErrors.avatarUrl && <p className="text-sm mt-1 error-text">{editIdentityErrors.avatarUrl}</p>}
                  </div>
                  <div className="field">
                    <label>{t("city")}</label>
                    <CitySearch
                      value={editIdentityDraft.city && editIdentityDraft.cityLat != null && editIdentityDraft.cityLng != null
                        ? { city: editIdentityDraft.city, lat: editIdentityDraft.cityLat, lng: editIdentityDraft.cityLng }
                        : null}
                      onChange={(selection) => {
                        if (selection) {
                          setEditIdentityDraft((prev) => (prev ? { ...prev, city: selection.city, cityLat: selection.lat, cityLng: selection.lng } : prev));
                        } else {
                          setEditIdentityDraft((prev) => (prev ? { ...prev, city: null, cityLat: null, cityLng: null } : prev));
                        }
                      }}
                      placeholder={t("auth:whereBased")}
                    />
                  </div>
                  <div className="field">
                    <label>{t("language")}</label>
                    <select
                      value={editIdentityDraft.preferredLanguage}
                      onChange={(e) => setEditIdentityDraft((prev) => (prev ? { ...prev, preferredLanguage: e.target.value as "en" | "de" } : prev))}
                    >
                      {languageOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>{t("defaultEventVisibility")}</label>
                    <select
                      value={editIdentityDraft.defaultVisibility}
                      onChange={(e) => setEditIdentityDraft((prev) => (prev ? { ...prev, defaultVisibility: e.target.value as "public" | "unlisted" | "followers_only" | "private" } : prev))}
                    >
                      {visibilityOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={editIdentityDraft.discoverable}
                        onChange={(e) => setEditIdentityDraft((prev) => (prev ? { ...prev, discoverable: e.target.checked } : prev))}
                        style={{ width: "auto" }}
                      />
                      {t("discoverableIdentity")}
                    </label>
                  </div>
                  <div className="flex items-center gap-1" style={{ justifyContent: "space-between" }}>
                    <button type="submit" className="btn-primary btn-sm" disabled={identityBusy || !canAdminMembers}>
                      {identityBusy ? t("common:saving") : t("common:save")}
                    </button>
                    {isOwner && (
                      <button
                        type="button"
                        className="btn-danger btn-sm"
                        onClick={() => handleDeleteIdentity(editIdentityDraft.username)}
                      >
                        {t("deleteIdentity")}
                      </button>
                    )}
                  </div>
                  {identityError && <p className="text-sm mt-1 error-text">{identityError}</p>}
                </form>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {membersModalOpen && selectedIdentity && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && setMembersModalOpen(false)}
        >
          <div className="modal-card settings-members-modal-card">
            <div className="modal-header">
              <h3 className="settings-section-title" style={{ margin: 0 }}>
                {t("identityMembers")}: @{selectedIdentity.username}
              </h3>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setMembersModalOpen(false)}>
                {t("common:close")}
              </button>
            </div>
            <div className="modal-body settings-identity-modal-body">
              {canAdminMembers && (
                <form onSubmit={handleInviteMember} className="settings-members-invite-form">
                  <div className="field" ref={memberResultsRef}>
                    <label>{t("addMember")}</label>
                    <div style={{ position: "relative" }}>
                      <div className="prefixed-input">
                        <span className="prefixed-input-prefix" aria-hidden="true">@</span>
                        <input
                          value={inviteUsername}
                          onChange={(e) => {
                            setInviteUsername(e.target.value);
                            setIdentityError("");
                            setShowMemberSuggestions(true);
                          }}
                          onFocus={() => {
                            if (inviteUsername.trim().length >= 2 || memberSuggestions.length > 0) {
                              setShowMemberSuggestions(true);
                            }
                          }}
                          placeholder={t("usernamePlaceholder")}
                          autoComplete="off"
                        />
                      </div>
                      {showMemberSuggestions && inviteUsername.trim().length >= 2 && (
                        <div className="venue-dropdown">
                          {memberSuggestions.map((candidate) => (
                            <button
                              key={candidate.id}
                              type="button"
                              className="venue-dropdown-item"
                              onClick={() => {
                                skipNextMemberLookupRef.current = true;
                                setInviteUsername(candidate.username);
                                setMemberSuggestions([]);
                                setShowMemberSuggestions(false);
                              }}
                            >
                              <span className="venue-dropdown-name">{candidate.displayName || candidate.username}</span>
                              <span className="venue-dropdown-addr">@{candidate.username}</span>
                            </button>
                          ))}
                          {memberLookupBusy && (
                            <div className="venue-dropdown-item" style={{ cursor: "default" }}>
                              <span className="venue-dropdown-addr">{t("common:searching")}</span>
                            </div>
                          )}
                          {!memberLookupBusy && memberSuggestions.length === 0 && (
                            <div className="venue-dropdown-item" style={{ cursor: "default" }}>
                              <span className="venue-dropdown-addr">{t("noPublicProfilesFound")}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="field">
                    <label>{t("memberRole")}</label>
                    <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as IdentityRole)}>
                      <option value="editor">{t("role.editor")}</option>
                      <option value="admin">{t("role.admin")}</option>
                      <option value="owner">{t("role.owner")}</option>
                    </select>
                  </div>
                  <button type="submit" className="btn-primary btn-sm" disabled={!inviteUsername.trim() || identityBusy}>
                    {t("inviteMember")}
                  </button>
                  {identityError && <p className="text-sm mt-1 error-text">{identityError}</p>}
                </form>
              )}

              <div className="settings-keys-list" style={{ marginBottom: 0 }}>
                {identityMembers.map((member) => (
                  <div key={member.memberId} className="settings-key-row">
                    <div>
                      <span style={{ fontWeight: 500 }}>{member.displayName || member.username}</span>
                      <span className="text-sm text-dim" style={{ marginLeft: "0.5rem" }}>@{member.username}</span>
                    </div>
                    <div className="flex gap-1 items-center">
                      <select
                        value={member.role}
                        disabled={!canAdminMembers || memberBusyId === member.memberId || (!isOwner && member.role === "owner")}
                        onChange={(e) => handleUpdateMemberRole(member.memberId, e.target.value as IdentityRole)}
                      >
                        <option value="editor">{t("role.editor")}</option>
                        <option value="admin">{t("role.admin")}</option>
                        <option value="owner">{t("role.owner")}</option>
                      </select>
                      <button
                        type="button"
                        className="btn-danger btn-sm"
                        disabled={!canAdminMembers || memberBusyId === member.memberId || (!isOwner && member.role === "owner")}
                        onClick={() => handleRemoveMember(member.memberId)}
                      >
                        {t("common:remove")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
