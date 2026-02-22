import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { auth as authApi } from "../lib/api";
import { Link } from "wouter";
import { CitySearch, type CitySelection } from "../components/CitySearch";
import { UserIcon, LockIcon, BellIcon, KeyIcon, TrashIcon } from "../components/icons";
import { changeLanguage } from "../i18n";
import "./SettingsPage.css";

export function SettingsPage() {
  const { t, i18n } = useTranslation(["settings", "common", "auth"]);

  const SECTIONS: { id: string; label: string; icon: React.ComponentType<{ className?: string }>; danger?: boolean }[] = [
    { id: "profile", label: t("profile"), icon: UserIcon },
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
  }, [user]);

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
    setSaving(true);
    setSaved(false);
    try {
      await authApi.updateProfile({
        displayName,
        bio,
        website,
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
                <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="bio">{t("bio")}</label>
                <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} />
              </div>
              <div className="field">
                <label htmlFor="website">{t("website")}</label>
                <input
                  id="website"
                  type="url"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder={t("websitePlaceholder")}
                />
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
                  <option value="en">{t("english")}</option>
                  <option value="de">{t("german")}</option>
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
    </div>
  );
}
