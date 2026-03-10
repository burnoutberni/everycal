import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isValidHttpUrl,
  isValidIdentityHandle,
  normalizeHttpUrlInput,
  normalizeHandle,
} from "@everycal/core";
import { useAuth } from "../hooks/useAuth";
import { invalidateAdditionalIdentitiesCache } from "../hooks/additionalIdentitiesCache";
import {
  auth as authApi,
  identities as identitiesApi,
  uploads,
  users as usersApi,
  type User,
  type PublishingIdentity,
  type IdentityMember,
  type IdentityRole,
} from "../lib/api";
import { Link, useLocation } from "wouter";
import { ProfileHeader } from "../components/ProfileHeader";
import { CitySearch, type CitySelection } from "../components/CitySearch";
import { TimezonePicker } from "../components/TimezonePicker";
import { UserIcon, LockIcon, CalendarIcon, BellIcon, KeyIcon, TrashIcon, PenIcon } from "../components/icons";
import { profilePath } from "../lib/urls";
import { changeLanguage } from "../i18n";
import { validateAvatarUpload } from "../lib/avatarUpload";
import {
  browserTimezone,
  buildCountryLocaleOptions,
  localeRegion,
  localeWeekStart,
  resolveDateTimeLocale,
  SYSTEM_DATE_TIME_LOCALE,
  SYSTEM_TIMEZONE,
} from "../lib/dateTimeLocale";
import "./SettingsPage.css";

type IdentityFormErrors = {
  username?: string;
  website?: string;
  avatarUrl?: string;
};

export function SettingsPage() {
  const { t, i18n } = useTranslation(["settings", "common", "auth", "profile", "timezones"]);
  const [, setLocation] = useLocation();
  const allowLocalhostUrls = typeof window !== "undefined"
    && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

  const SECTIONS: { id: string; label: string; icon: React.ComponentType<{ className?: string }>; danger?: boolean }[] = [
    { id: "calendar", label: t("calendarSettings"), icon: CalendarIcon },
    { id: "account", label: t("account"), icon: LockIcon },
    { id: "notifications", label: t("notifications"), icon: BellIcon },
    { id: "identities", label: t("publishingIdentities"), icon: UserIcon },
    { id: "api-keys", label: t("apiKeys"), icon: KeyIcon },
    { id: "danger", label: t("dangerZone"), icon: TrashIcon, danger: true },
  ];
  const { user, refreshUser } = useAuth();
  const [activeSection, setActiveSection] = useState<string>("calendar");
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

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
  const [timezone, setTimezone] = useState<string>(SYSTEM_TIMEZONE);
  const [dateTimeLocale, setDateTimeLocale] = useState<string>(SYSTEM_DATE_TIME_LOCALE);
  const [dateTimeCountryQuery, setDateTimeCountryQuery] = useState("");
  const [showDateTimeCountrySuggestions, setShowDateTimeCountrySuggestions] = useState(false);
  const [dateTimeCountryHighlight, setDateTimeCountryHighlight] = useState(0);
  const [discoverable, setDiscoverable] = useState(false);
  const [city, setCity] = useState<CitySelection | null>(null);
  const [savingCalendarSettings, setSavingCalendarSettings] = useState(false);
  const [savedCalendarSettings, setSavedCalendarSettings] = useState(false);
  const [calendarSettingsError, setCalendarSettingsError] = useState<string | null>(null);
  const [savingAccountSettings, setSavingAccountSettings] = useState(false);
  const [savedAccountSettings, setSavedAccountSettings] = useState(false);
  const [accountSettingsError, setAccountSettingsError] = useState<string | null>(null);

  const [identities, setIdentities] = useState<PublishingIdentity[]>([]);
  const [selectedIdentityUsername, setSelectedIdentityUsername] = useState("");
  const [identityMembers, setIdentityMembers] = useState<IdentityMember[]>([]);
  const [identityError, setIdentityError] = useState("");
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityAvatarUploading, setIdentityAvatarUploading] = useState(false);
  const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
  const [identityEditorOpen, setIdentityEditorOpen] = useState<"create" | null>(null);
  const [createIdentityStep, setCreateIdentityStep] = useState<1 | 2 | 3>(1);
  const [identitySettingsOpen, setIdentitySettingsOpen] = useState(false);
  const [identitySettingsDraft, setIdentitySettingsDraft] = useState<{
    username: string;
    discoverable: boolean;
    defaultVisibility: "public" | "unlisted" | "followers_only" | "private";
    city: CitySelection | null;
    preferredLanguage: "en" | "de";
  } | null>(null);
  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [createIdentityUsername, setCreateIdentityUsername] = useState("");
  const [createIdentityDisplayName, setCreateIdentityDisplayName] = useState("");
  const [createIdentityBio, setCreateIdentityBio] = useState("");
  const [createIdentityWebsite, setCreateIdentityWebsite] = useState("");
  const [createIdentityAvatarUrl, setCreateIdentityAvatarUrl] = useState("");
  const [createIdentityDiscoverable, setCreateIdentityDiscoverable] = useState(true);
  const [createIdentityDefaultVisibility, setCreateIdentityDefaultVisibility] = useState<"public" | "unlisted" | "followers_only" | "private">("public");
  const [createIdentityCity, setCreateIdentityCity] = useState<CitySelection | null>(null);
  const [createIdentityPreferredLanguage, setCreateIdentityPreferredLanguage] = useState<"en" | "de">("en");
  const [createIdentityErrors, setCreateIdentityErrors] = useState<IdentityFormErrors>({});
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<IdentityRole>("editor");
  const [memberSuggestions, setMemberSuggestions] = useState<User[]>([]);
  const [memberLookupBusy, setMemberLookupBusy] = useState(false);
  const [showMemberSuggestions, setShowMemberSuggestions] = useState(false);
  const memberResultsRef = useRef<HTMLDivElement | null>(null);
  const skipNextMemberLookupRef = useRef(false);
  const identityModalRef = useRef<HTMLDivElement | null>(null);
  const membersModalRef = useRef<HTMLDivElement | null>(null);
  const dateTimeCountryRef = useRef<HTMLDivElement | null>(null);
  const identitySettingsModalRef = useRef<HTMLDivElement | null>(null);
  const identityModalTriggerRef = useRef<HTMLElement | null>(null);
  const identitySettingsModalTriggerRef = useRef<HTMLElement | null>(null);
  const membersModalTriggerRef = useRef<HTMLElement | null>(null);
  const identityModalTitleId = useId();
  const identitySettingsModalTitleId = useId();
  const membersModalTitleId = useId();
  const dateTimeCountryListboxId = useId();

  useEffect(() => {
    if (!user) return;
    authApi.me().then((u) => {
      setPreferredLanguage(u.preferredLanguage || "en");
      setTimezone(u.timezone || SYSTEM_TIMEZONE);
      setDateTimeLocale(u.dateTimeLocale || SYSTEM_DATE_TIME_LOCALE);
      setDiscoverable(!!u.discoverable);
      setCity(u.city && u.cityLat != null && u.cityLng != null ? { city: u.city, lat: u.cityLat, lng: u.cityLng } : null);
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
      setIdentities(res.identities);
    }).catch(() => {
      setIdentities([]);
    });
  }, [user]);

  const dateTimeCountryOptions = useMemo(
    () => buildCountryLocaleOptions(i18n.language, preferredLanguage || i18n.language),
    [i18n.language, preferredLanguage],
  );

  const effectiveDateTimeLocale = useMemo(
    () => resolveDateTimeLocale({ dateTimeLocale }, i18n.language),
    [dateTimeLocale, i18n.language],
  );

  const runtimeSystemDateTimeLocale = useMemo(
    () => resolveDateTimeLocale({ dateTimeLocale: SYSTEM_DATE_TIME_LOCALE }, i18n.language),
    [i18n.language],
  );

  const systemTimezoneLabelValue = useMemo(() => {
    const runtimeTimezone = browserTimezone();
    const fallbackCity = (runtimeTimezone.split("/").pop() || runtimeTimezone).replace(/_/g, " ");
    const city = t(`timezones:cities.${runtimeTimezone.replace(/\//g, "_")}`, { defaultValue: fallbackCity });
    return city || runtimeTimezone;
  }, [t]);

  const systemLocaleCountry = useMemo(() => {
    const region = localeRegion(runtimeSystemDateTimeLocale);
    if (!region) return runtimeSystemDateTimeLocale;
    return dateTimeCountryOptions.find((option) => option.regionCode === region)?.countryName || region;
  }, [dateTimeCountryOptions, runtimeSystemDateTimeLocale]);

  const systemDateTimeLocaleOption = useMemo(() => {
    const dateSample = new Intl.DateTimeFormat(runtimeSystemDateTimeLocale, { dateStyle: "short" }).format(new Date(2026, 11, 31));
    const timeSample = new Intl.DateTimeFormat(runtimeSystemDateTimeLocale, { timeStyle: "short" }).format(new Date(2026, 11, 31, 18, 30));
    const label = t("useSystemDateTimeLocale", { country: systemLocaleCountry, locale: runtimeSystemDateTimeLocale });
    return {
      regionCode: SYSTEM_DATE_TIME_LOCALE,
      countryName: label,
      locale: runtimeSystemDateTimeLocale,
      searchText: `${label} ${t("systemSetting")} ${runtimeSystemDateTimeLocale} ${dateSample} ${timeSample}`.toLowerCase(),
      isSystem: true,
    };
  }, [runtimeSystemDateTimeLocale, systemLocaleCountry, t]);

  const selectedDateTimeCountry = useMemo(() => {
    if (dateTimeLocale === SYSTEM_DATE_TIME_LOCALE) return systemDateTimeLocaleOption.countryName;
    const region = localeRegion(dateTimeLocale);
    if (!region) return "";
    return dateTimeCountryOptions.find((option) => option.regionCode === region)?.countryName || region;
  }, [dateTimeCountryOptions, dateTimeLocale, systemDateTimeLocaleOption.countryName]);

  useEffect(() => {
    if (!showDateTimeCountrySuggestions) {
      setDateTimeCountryQuery(selectedDateTimeCountry);
    }
  }, [selectedDateTimeCountry, showDateTimeCountrySuggestions]);

  const filteredDateTimeCountryOptions = useMemo(() => {
    const normalized = dateTimeCountryQuery.trim().toLowerCase();
    return normalized
      ? dateTimeCountryOptions.filter((option) => option.searchText.includes(normalized))
      : dateTimeCountryOptions;
  }, [dateTimeCountryOptions, dateTimeCountryQuery]);

  const visibleDateTimeCountryOptions = useMemo(
    () => [systemDateTimeLocaleOption, ...filteredDateTimeCountryOptions],
    [filteredDateTimeCountryOptions, systemDateTimeLocaleOption],
  );

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!dateTimeCountryRef.current?.contains(event.target as Node)) {
        setShowDateTimeCountrySuggestions(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

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
    if (!isValidHttpUrl(normalized, { allowLocalhost: allowLocalhostUrls })) return { normalized, error: t(errorKey) };
    return { normalized, error: undefined as string | undefined };
  };

  const validateWebsite = (value: string): { normalized: string; error?: string } =>
    normalizeAndValidateUrl(value, "invalidWebsiteUrl");

  const validateAvatarUrl = (value: string): { normalized: string; error?: string } =>
    normalizeAndValidateUrl(value, "invalidAvatarUrl");

  const normalizeAvatarForApi = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (typeof window !== "undefined") {
      try {
        const parsed = new URL(trimmed, window.location.origin);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          return parsed.toString();
        }
      } catch {
        // fall back to text normalization below
      }
    }
    return normalizeHttpUrlInput(trimmed);
  };

  const validateIdentityHandle = (value: string): string | undefined => {
    const normalized = normalizeHandle(value);
    if (!normalized) return t("identityHandleRequired");
    if (!isValidIdentityHandle(normalized)) {
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
  const canManageMembers = selectedRole === "owner";
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
    if (!identitySettingsOpen) return;
    const root = identitySettingsModalRef.current;
    if (!root) return;
    const focusableSelector =
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
    const first = focusable[0] || null;
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIdentitySettingsOpen(false);
        setIdentitySettingsDraft(null);
        identitySettingsModalTriggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (!active || active === firstEl) {
          event.preventDefault();
          lastEl.focus();
        }
        return;
      }
      if (active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [identitySettingsOpen]);

  useEffect(() => {
    if (!identityEditorOpen) return;
    const root = identityModalRef.current;
    if (!root) return;
    const focusableSelector =
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
    const first = focusable[0] || null;
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeIdentityEditorModal();
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (!active || active === firstEl) {
          event.preventDefault();
          lastEl.focus();
        }
        return;
      }
      if (active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [identityEditorOpen]);

  useEffect(() => {
    if (!membersModalOpen) return;
    const root = membersModalRef.current;
    if (!root) return;
    const focusableSelector =
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
    const first = focusable[0] || null;
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMembersModal();
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (!active || active === firstEl) {
          event.preventDefault();
          lastEl.focus();
        }
        return;
      }
      if (active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
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

  const handleCreateKey = async () => {
    if (!newKeyLabel) return;
    const result = await authApi.createApiKey(newKeyLabel);
    setNewKeyValue(result.key);
    setNewKeyLabel("");
    authApi.listApiKeys().then((r) => setKeys(r.keys));
  };

  const handleSaveCalendarSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCalendarSettings(true);
    setSavedCalendarSettings(false);
    setCalendarSettingsError(null);
    try {
      await authApi.updateProfile({
        timezone,
        dateTimeLocale,
      });
      await refreshUser();
      setSavedCalendarSettings(true);
      setTimeout(() => setSavedCalendarSettings(false), 1800);
    } catch (err: unknown) {
      setCalendarSettingsError((err as Error).message || t("common:requestFailed"));
    } finally {
      setSavingCalendarSettings(false);
    }
  };

  const handleSaveAccountSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAccountSettings(true);
    setSavedAccountSettings(false);
    setAccountSettingsError(null);
    try {
      await authApi.updateProfile({
        discoverable,
        preferredLanguage,
        city: city ? city.city : null,
        cityLat: city ? city.lat : null,
        cityLng: city ? city.lng : null,
      });
      changeLanguage((preferredLanguage === "de" ? "de" : "en"));
      await refreshUser();
      setSavedAccountSettings(true);
      setTimeout(() => setSavedAccountSettings(false), 1800);
    } catch (err: unknown) {
      setAccountSettingsError((err as Error).message || t("common:requestFailed"));
    } finally {
      setSavingAccountSettings(false);
    }
  };

  const normalizeCreateIdentityProfileUrls = () => {
    const websiteResult = validateWebsite(createIdentityWebsite);
    const avatarResult = validateAvatarUrl(normalizeAvatarForApi(createIdentityAvatarUrl));
    return {
      websiteResult,
      avatarResult,
    };
  };

  const handleCreateIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    setIdentityError("");

    const normalizedUsername = normalizeHandle(createIdentityUsername);
    const { websiteResult, avatarResult } = normalizeCreateIdentityProfileUrls();
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
      const created = await identitiesApi.create({
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
      if (user?.id) invalidateAdditionalIdentitiesCache(user.id);
      closeIdentityEditorModal();
      setLocation(profilePath(created.identity.username));
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setIdentityBusy(false);
    }
  };

  const validateCreateIdentityStep = (step: 1 | 2): boolean => {
    if (step === 1) {
      const normalizedUsername = normalizeHandle(createIdentityUsername);
      const usernameError = validateIdentityHandle(normalizedUsername);
      setCreateIdentityUsername(normalizedUsername);
      setCreateIdentityErrors((prev) => ({ ...prev, username: usernameError }));
      return !usernameError;
    }

    const { websiteResult, avatarResult } = normalizeCreateIdentityProfileUrls();
    setCreateIdentityWebsite(websiteResult.normalized);
    setCreateIdentityAvatarUrl(avatarResult.normalized);
    setCreateIdentityErrors((prev) => ({
      ...prev,
      website: websiteResult.error,
      avatarUrl: avatarResult.error,
    }));
    return !websiteResult.error && !avatarResult.error;
  };

  const handleDeleteIdentity = async (username: string) => {
    if (!confirm(t("deleteIdentityConfirm", { username }))) return;
    setIdentityError("");
    try {
      await identitiesApi.delete(username);
      if (user?.id) invalidateAdditionalIdentitiesCache(user.id);
      const res = await identitiesApi.list();
      setIdentities(res.identities);
      setSelectedIdentityUsername((current) => (current === username ? "" : current));
      closeIdentityEditorModal();
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    }
  };

  const openIdentitySettingsModal = (identity: PublishingIdentity) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) identitySettingsModalTriggerRef.current = active;
    setIdentityError("");
    setIdentitySettingsDraft({
      username: identity.username,
      discoverable: identity.discoverable,
      defaultVisibility: identity.defaultVisibility,
      preferredLanguage: identity.preferredLanguage,
      city: identity.city && identity.cityLat != null && identity.cityLng != null
        ? { city: identity.city, lat: identity.cityLat, lng: identity.cityLng }
        : null,
    });
    setIdentitySettingsOpen(true);
  };

  const closeIdentitySettingsModal = () => {
    setIdentitySettingsOpen(false);
    setIdentitySettingsDraft(null);
    identitySettingsModalTriggerRef.current?.focus();
  };

  const handleSaveIdentitySettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identitySettingsDraft) return;
    setIdentityBusy(true);
    setIdentityError("");
    try {
      await identitiesApi.update(identitySettingsDraft.username, {
        discoverable: identitySettingsDraft.discoverable,
        defaultVisibility: identitySettingsDraft.defaultVisibility,
        preferredLanguage: identitySettingsDraft.preferredLanguage,
        city: identitySettingsDraft.city ? identitySettingsDraft.city.city : null,
        cityLat: identitySettingsDraft.city ? identitySettingsDraft.city.lat : null,
        cityLng: identitySettingsDraft.city ? identitySettingsDraft.city.lng : null,
      });
      const res = await identitiesApi.list();
      setIdentities(res.identities);
      closeIdentitySettingsModal();
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setIdentityBusy(false);
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
    setCreateIdentityStep(1);
    setIdentityAvatarUploading(false);
    setCreateIdentityErrors({});
    setIdentityError("");
    identityModalTriggerRef.current?.focus();
  };

  const closeMembersModal = () => {
    setMembersModalOpen(false);
    membersModalTriggerRef.current?.focus();
  };

  const openCreateIdentityModal = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) identityModalTriggerRef.current = active;
    setIdentityError("");
    setCreateIdentityErrors({});
    setCreateIdentityUsername("");
    setCreateIdentityDisplayName("");
    setCreateIdentityBio("");
    setCreateIdentityWebsite("");
    setCreateIdentityAvatarUrl("");
    setCreateIdentityDiscoverable(true);
    setCreateIdentityDefaultVisibility("public");
    setCreateIdentityCity(null);
    setCreateIdentityPreferredLanguage(preferredLanguage === "de" ? "de" : "en");
    setCreateIdentityStep(1);
    setIdentityAvatarUploading(false);
    setIdentityEditorOpen("create");
  };

  const openMembersModal = (username: string) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) membersModalTriggerRef.current = active;
    setIdentityError("");
    setInviteUsername("");
    setInviteRole("editor");
    setMemberSuggestions([]);
    setShowMemberSuggestions(false);
    setMemberLookupBusy(false);
    setSelectedIdentityUsername(username);
    setMembersModalOpen(true);
  };

  const handleCreateIdentityAvatarUpload = async (file: File) => {
    setIdentityError("");
    const uploadErrorKey = validateAvatarUpload(file);
    if (uploadErrorKey) {
      setIdentityError(t(uploadErrorKey, { maxMb: 5 }));
      return;
    }
    setIdentityAvatarUploading(true);
    try {
      const result = await uploads.upload(file);
      setCreateIdentityAvatarUrl(result.url);
    } catch (err: unknown) {
      setIdentityError((err as Error).message || t("identityActionFailed"));
    } finally {
      setIdentityAvatarUploading(false);
    }
  };

  const previewUsername = normalizeHandle(createIdentityUsername) || "new_identity";
  const createIdentitySteps = [
    { step: 1, label: t("createIdentityStepHandle") },
    { step: 2, label: t("createIdentityStepProfile") },
    { step: 3, label: t("createIdentityStepSettings") },
  ] as const;

  const identityPreviewProfile: User = {
    id: "identity-preview",
    username: previewUsername,
    accountType: "identity",
    displayName: createIdentityDisplayName || previewUsername,
    bio: createIdentityBio || null,
    avatarUrl: createIdentityAvatarUrl || null,
    website: createIdentityWebsite || null,
    isBot: false,
    discoverable: createIdentityDiscoverable,
    followersCount: 0,
    followingCount: 0,
    eventsCount: 0,
    createdAt: new Date().toISOString(),
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
          id="calendar"
          ref={(el) => { sectionRefs.current.calendar = el; }}
          className="settings-section"
          aria-labelledby="calendar-heading"
        >
          <div className="settings-card">
            <h2 id="calendar-heading" className="settings-section-title">
              {t("calendarSettings")}
            </h2>
            <form onSubmit={handleSaveCalendarSettings} className="mb-1">
              <div className="field">
                <label htmlFor="settings-time-format">{t("dateTimeLocale")}</label>
                <div ref={dateTimeCountryRef} style={{ position: "relative" }}>
                  <input
                    id="settings-time-format"
                    value={dateTimeCountryQuery}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-expanded={showDateTimeCountrySuggestions && visibleDateTimeCountryOptions.length > 0}
                    aria-controls={dateTimeCountryListboxId}
                    aria-activedescendant={
                      showDateTimeCountrySuggestions && visibleDateTimeCountryOptions[dateTimeCountryHighlight]
                        ? `${dateTimeCountryListboxId}-option-${dateTimeCountryHighlight}`
                        : undefined
                    }
                    onFocus={() => {
                      setDateTimeCountryQuery("");
                      setShowDateTimeCountrySuggestions(true);
                      setDateTimeCountryHighlight(0);
                    }}
                    onChange={(e) => {
                      setDateTimeCountryQuery(e.target.value);
                      setShowDateTimeCountrySuggestions(true);
                      setDateTimeCountryHighlight(0);
                    }}
                    onBlur={() => {
                      setTimeout(() => {
                        setShowDateTimeCountrySuggestions(false);
                        setDateTimeCountryQuery(selectedDateTimeCountry);
                      }, 120);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setShowDateTimeCountrySuggestions(true);
                        setDateTimeCountryHighlight((current) => Math.min(current + 1, Math.max(visibleDateTimeCountryOptions.length - 1, 0)));
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setDateTimeCountryHighlight((current) => Math.max(current - 1, 0));
                        return;
                      }
                      if (event.key === "Enter") {
                        const selected = visibleDateTimeCountryOptions[dateTimeCountryHighlight];
                        if (!selected) return;
                        event.preventDefault();
                        setDateTimeLocale(selected.regionCode === SYSTEM_DATE_TIME_LOCALE ? SYSTEM_DATE_TIME_LOCALE : selected.locale);
                        setDateTimeCountryQuery(selected.countryName);
                        setShowDateTimeCountrySuggestions(false);
                        return;
                      }
                      if (event.key === "Escape") {
                        setDateTimeCountryQuery(selectedDateTimeCountry);
                        setShowDateTimeCountrySuggestions(false);
                      }
                    }}
                    placeholder={t("dateTimeLocaleCountryPlaceholder")}
                    autoComplete="off"
                  />

                  {showDateTimeCountrySuggestions && visibleDateTimeCountryOptions.length > 0 && (
                    <div className="venue-dropdown" role="listbox" id={dateTimeCountryListboxId} aria-label={t("dateTimeLocale")}
                    >
                      {visibleDateTimeCountryOptions.map((option, index) => {
                        const dateSample = new Intl.DateTimeFormat(option.locale, { dateStyle: "short" }).format(new Date(2026, 11, 31));
                        const timeSample = new Intl.DateTimeFormat(option.locale, { timeStyle: "short" }).format(new Date(2026, 11, 31, 18, 30));
                        return (
                          <button
                            key={option.regionCode}
                            id={`${dateTimeCountryListboxId}-option-${index}`}
                            type="button"
                            className={`venue-dropdown-item locale-suggestion-item ${option.regionCode === SYSTEM_DATE_TIME_LOCALE ? "dropdown-pinned-item " : ""}${index === dateTimeCountryHighlight ? "timezone-item-active" : ""}`}
                            role="option"
                            aria-selected={index === dateTimeCountryHighlight}
                            onMouseEnter={() => setDateTimeCountryHighlight(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setDateTimeLocale(option.regionCode === SYSTEM_DATE_TIME_LOCALE ? SYSTEM_DATE_TIME_LOCALE : option.locale);
                              setDateTimeCountryQuery(option.countryName);
                              setShowDateTimeCountrySuggestions(false);
                            }}
                          >
                            <span className="venue-dropdown-name locale-suggestion-name">{option.countryName}</span>
                            <span className="venue-dropdown-addr locale-suggestion-preview">{`${dateSample} · ${timeSample}`}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="text-sm text-dim" style={{ marginTop: "0.35rem" }}>
                  {(() => {
                    const weekStart = localeWeekStart(effectiveDateTimeLocale);
                    const weekLabel = weekStart === 0 ? t("weekStartsSunday") : t("weekStartsMonday");
                    const dateSample = new Intl.DateTimeFormat(effectiveDateTimeLocale, { dateStyle: "short" }).format(new Date(2026, 11, 31));
                    const timeSample = new Intl.DateTimeFormat(effectiveDateTimeLocale, { timeStyle: "short" }).format(new Date(2026, 11, 31, 18, 30));
                    return `${weekLabel} · ${dateSample} · ${timeSample}`;
                  })()}
                </div>
              </div>
              <div className="field">
                <label htmlFor="settings-timezone">{t("common:timezone")}</label>
                <TimezonePicker
                  id="settings-timezone"
                  value={timezone}
                  onChange={setTimezone}
                  allowSystemOption
                  systemValue={SYSTEM_TIMEZONE}
                  systemLabel={t("useSystemTimezone", { timezone: systemTimezoneLabelValue })}
                />
              </div>
              <div className="flex items-center gap-1">
                <button type="submit" className="btn-primary btn-sm" disabled={savingCalendarSettings}>
                  {savingCalendarSettings ? t("common:saving") : t("common:save")}
                </button>
                {savedCalendarSettings && <span className="text-sm" style={{ color: "var(--success)" }}>{t("common:saved")}</span>}
              </div>
              {calendarSettingsError && <p className="text-sm mt-1 error-text" role="alert">{calendarSettingsError}</p>}
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
            <form onSubmit={handleSaveAccountSettings} className="mb-3" style={{ paddingBottom: "1rem", borderBottom: "1px solid var(--border)" }}>
              <div className="field">
                <label htmlFor="settings-city">{t("city")}</label>
                <CitySearch id="settings-city" value={city} onChange={setCity} placeholder={t("auth:whereBased")} />
              </div>
              <div className="field">
                <label htmlFor="settings-language">{t("language")}</label>
                <select
                  id="settings-language"
                  value={preferredLanguage}
                  onChange={(e) => setPreferredLanguage(e.target.value as "en" | "de")}
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
              </div>
              <div className="flex items-center gap-1">
                <button type="submit" className="btn-primary btn-sm" disabled={savingAccountSettings}>
                  {savingAccountSettings ? t("common:saving") : t("common:save")}
                </button>
                {savedAccountSettings && <span className="text-sm" style={{ color: "var(--success)" }}>{t("common:saved")}</span>}
              </div>
              {accountSettingsError && <p className="text-sm mt-1 error-text" role="alert">{accountSettingsError}</p>}
            </form>
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
                        <div className="identity-card-title-row">
                          <Link href={profilePath(identity.username)} className="identity-card-title-link">
                            {identity.displayName || identity.username}
                          </Link>
                          <Link
                            href={`${profilePath(identity.username)}?edit=1`}
                            className="identity-card-edit-link"
                            aria-label={t("common:edit")}
                            title={t("common:edit")}
                          >
                            <PenIcon />
                          </Link>
                        </div>
                        <p className="identity-card-handle">@{identity.username}</p>
                      </div>
                      <span className="identity-role-chip">{t(`role.${identity.role}`)}</span>
                    </div>
                    <div className="identity-card-actions">
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => openIdentitySettingsModal(identity)}
                      >
                        {t("identitySettings")}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => openMembersModal(identity.username)}
                        disabled={identity.role !== "owner"}
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
          aria-labelledby={identityModalTitleId}
          onClick={(e) => e.target === e.currentTarget && closeIdentityEditorModal()}
        >
          <div className="modal-card settings-identity-modal-card" ref={identityModalRef}>
            <div className="modal-header">
              <h3 id={identityModalTitleId} className="settings-section-title" style={{ margin: 0 }}>
                {t("createPublishingIdentity")}
              </h3>
              <button type="button" className="btn-ghost btn-sm" onClick={closeIdentityEditorModal}>
                {t("common:close")}
              </button>
            </div>
            <div className="modal-body settings-identity-modal-body">
              <form
                onSubmit={(e) => {
                  if (createIdentityStep === 1 || createIdentityStep === 2) {
                    e.preventDefault();
                    setIdentityError("");
                    if (validateCreateIdentityStep(createIdentityStep)) {
                      setCreateIdentityStep((prev) => (prev === 1 ? 2 : 3));
                    }
                    return;
                  }
                  handleCreateIdentity(e);
                }}
              >
                <div className="settings-wizard-progress" aria-label={t("createIdentityStepProgress", { current: createIdentityStep, total: 3 })}>
                  {createIdentitySteps.map((item) => (
                    <div
                      key={item.step}
                      className={`settings-wizard-step ${createIdentityStep === item.step ? "is-active" : ""} ${createIdentityStep > item.step ? "is-done" : ""}`}
                    >
                      <span className="settings-wizard-step-index">{item.step}</span>
                      <span className="settings-wizard-step-label">{item.label}</span>
                    </div>
                  ))}
                </div>

                {createIdentityStep === 1 && (
                  <>
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
                            const normalized = normalizeHandle(createIdentityUsername);
                            setCreateIdentityUsername(normalized);
                            setCreateIdentityErrors((prev) => ({ ...prev, username: validateIdentityHandle(normalized) }));
                          }}
                          placeholder={t("usernamePlaceholder")}
                          required
                        />
                      </div>
                      <p className="text-sm text-dim mt-1">{t("identityHandleImmutableHelp")}</p>
                      {createIdentityErrors.username && <p className="text-sm mt-1 error-text">{createIdentityErrors.username}</p>}
                    </div>
                  </>
                )}

                {createIdentityStep === 2 && (
                  <>
                    <p className="text-sm text-dim mb-2">{t("identityPreviewHelp")}</p>
                    <ProfileHeader
                      profile={identityPreviewProfile}
                      currentUser={user}
                      isOwn
                      isRemote={false}
                      isMobile={false}
                      editingProfile
                      inlineDraft={{
                        displayName: createIdentityDisplayName,
                        bio: createIdentityBio,
                        website: createIdentityWebsite,
                        avatarUrl: createIdentityAvatarUrl,
                      }}
                      onInlineDraftChange={(next) => {
                        setCreateIdentityDisplayName(next.displayName);
                        setCreateIdentityBio(next.bio);
                        setCreateIdentityWebsite(next.website);
                        setCreateIdentityAvatarUrl(next.avatarUrl);
                        setCreateIdentityErrors((prev) => ({ ...prev, website: undefined, avatarUrl: undefined }));
                      }}
                      onInlineAvatarUpload={handleCreateIdentityAvatarUpload}
                      avatarUploading={identityAvatarUploading}
                      hideInlineActions
                      inlineError={createIdentityErrors.website || createIdentityErrors.avatarUrl || null}
                    />
                  </>
                )}

                {createIdentityStep === 3 && (
                  <>
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
                  </>
                )}

                <div className="settings-wizard-actions">
                  {createIdentityStep > 1 && (
                    <button
                      type="button"
                      className="btn-ghost btn-sm settings-wizard-back"
                      onClick={() => {
                        setIdentityError("");
                        setCreateIdentityStep((prev) => (prev === 3 ? 2 : 1));
                      }}
                      disabled={identityBusy}
                    >
                      <span aria-hidden="true">&larr;</span>
                      {t("common:back")}
                    </button>
                  )}
                  {createIdentityStep < 3 ? (
                    <button type="submit" className="btn-primary btn-sm settings-wizard-next" disabled={identityBusy || identityAvatarUploading}>
                      {t("createIdentityNextStep")}
                      <span aria-hidden="true">&rarr;</span>
                    </button>
                  ) : (
                    <button type="submit" className="btn-primary btn-sm settings-wizard-next" disabled={identityBusy || identityAvatarUploading}>
                      {identityBusy ? t("common:saving") : t("createAndEditIdentity")}
                    </button>
                  )}
                </div>
                {identityError && <p className="text-sm mt-1 error-text">{identityError}</p>}
              </form>
            </div>
          </div>
        </div>
      )}

      {identitySettingsOpen && identitySettingsDraft && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={identitySettingsModalTitleId}
          onClick={(e) => e.target === e.currentTarget && closeIdentitySettingsModal()}
        >
          <div className="modal-card settings-identity-modal-card" ref={identitySettingsModalRef}>
            <div className="modal-header">
              <h3 id={identitySettingsModalTitleId} className="settings-section-title" style={{ margin: 0 }}>
                {t("identitySettings")}: @{identitySettingsDraft.username}
              </h3>
              <button type="button" className="btn-ghost btn-sm" onClick={closeIdentitySettingsModal}>
                {t("common:close")}
              </button>
            </div>
            <div className="modal-body settings-identity-modal-body">
              <form onSubmit={handleSaveIdentitySettings}>
                <div className="field">
                  <label>{t("city")}</label>
                  <CitySearch
                    value={identitySettingsDraft.city}
                    onChange={(value) => setIdentitySettingsDraft((prev) => (prev ? { ...prev, city: value } : prev))}
                    placeholder={t("auth:whereBased")}
                  />
                </div>
                <div className="field">
                  <label>{t("language")}</label>
                  <select
                    value={identitySettingsDraft.preferredLanguage}
                    onChange={(e) => setIdentitySettingsDraft((prev) => (prev ? { ...prev, preferredLanguage: e.target.value as "en" | "de" } : prev))}
                  >
                    {languageOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{t("defaultEventVisibility")}</label>
                  <select
                    value={identitySettingsDraft.defaultVisibility}
                    onChange={(e) => setIdentitySettingsDraft((prev) => (prev ? { ...prev, defaultVisibility: e.target.value as "public" | "unlisted" | "followers_only" | "private" } : prev))}
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
                      checked={identitySettingsDraft.discoverable}
                      onChange={(e) => setIdentitySettingsDraft((prev) => (prev ? { ...prev, discoverable: e.target.checked } : prev))}
                      style={{ width: "auto" }}
                    />
                    {t("discoverableIdentity")}
                  </label>
                </div>
                <div className="flex items-center gap-1">
                  <button type="submit" className="btn-primary btn-sm" disabled={identityBusy}>
                    {identityBusy ? t("common:saving") : t("common:save")}
                  </button>
                </div>
                {identityError && <p className="text-sm mt-1 error-text">{identityError}</p>}
              </form>
            </div>
          </div>
        </div>
      )}

      {membersModalOpen && selectedIdentity && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={membersModalTitleId}
          onClick={(e) => e.target === e.currentTarget && closeMembersModal()}
        >
          <div className="modal-card settings-members-modal-card" ref={membersModalRef}>
            <div className="modal-header">
              <h3 id={membersModalTitleId} className="settings-section-title" style={{ margin: 0 }}>
                {t("identityMembers")}: @{selectedIdentity.username}
              </h3>
              <button type="button" className="btn-ghost btn-sm" onClick={closeMembersModal}>
                {t("common:close")}
              </button>
            </div>
            <div className="modal-body settings-identity-modal-body">
              {canManageMembers && (
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
                        disabled={!canManageMembers || memberBusyId === member.memberId || (!isOwner && member.role === "owner")}
                        onChange={(e) => handleUpdateMemberRole(member.memberId, e.target.value as IdentityRole)}
                      >
                        <option value="editor">{t("role.editor")}</option>
                        <option value="owner">{t("role.owner")}</option>
                      </select>
                      <button
                        type="button"
                        className="btn-danger btn-sm"
                        disabled={!canManageMembers || memberBusyId === member.memberId || (!isOwner && member.role === "owner")}
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
