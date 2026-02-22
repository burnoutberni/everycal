import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { auth as authApi, feeds as feedsApi } from "../lib/api";
import { CalendarSubscribeButtons } from "../components/CalendarSubscribeButtons";
import { CalendarIcon, CheckIcon, LinkIcon, MailIcon } from "../components/icons";

export function OnboardingPage() {
  const { t } = useTranslation("onboarding");
  const { user, refreshUser } = useAuth();
  const [, navigate] = useLocation();
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderHoursBefore, setReminderHoursBefore] = useState(24);
  const [eventUpdatedEnabled, setEventUpdatedEnabled] = useState(true);
  const [eventCancelledEnabled, setEventCancelledEnabled] = useState(true);
  const [copyStatus, setCopyStatus] = useState<
    "idle" | "copying" | "copied" | "error"
  >("idle");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    feedsApi.getCalendarUrl().then(({ url }) => setFeedUrl(url)).catch(() => {});
  }, []);

  if (!user) {
    navigate("/login");
    return null;
  }

  const handleCopyFeedLink = async () => {
    if (!feedUrl) return;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch {
      setCopyStatus("error");
      setTimeout(() => setCopyStatus("idle"), 2000);
    }
  };

  const handleContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await authApi.updateNotificationPrefs({
        reminderEnabled,
        reminderHoursBefore,
        eventUpdatedEnabled,
        eventCancelledEnabled,
        onboardingCompleted: true,
      });
      await refreshUser();
      navigate("/");
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="onboarding-page">
      <h1>{t("title")}</h1>
      <p className="onboarding-subtitle">{t("subtitle")}</p>

      <div className="onboarding-steps" role="progressbar" aria-label={t("setupProgressAria")}>
        <div
          className="onboarding-step-dot active"
          title={t("addToCalendar")}
          aria-hidden
        />
        <div className="onboarding-step-connector" aria-hidden />
        <div
          className="onboarding-step-dot active"
          title={t("notifications")}
          aria-hidden
        />
      </div>

      <div className="onboarding-card">
        <h2>
          <CalendarIcon />
          {t("addToLocalCalendar")}
        </h2>
        <p className="onboarding-card-desc">{t("addToCalendarDesc")}</p>
        <div className="onboarding-add-buttons">
          <CalendarSubscribeButtons feedUrl={feedUrl} />
        </div>
        <div className="onboarding-copy-row">
          <button
            type="button"
            className={`onboarding-copy-btn ${copyStatus === "copied" ? "copied" : ""}`}
            onClick={handleCopyFeedLink}
            disabled={copyStatus === "copying" || !feedUrl}
          >
            {copyStatus === "copied" ? (
              <CheckIcon />
            ) : (
              <LinkIcon />
            )}
            {copyStatus === "copied" && t("copied")}
            {copyStatus === "error" && t("copyFailed")}
            {copyStatus === "copying" && t("copying")}
            {copyStatus === "idle" && t("copyLinkInstead")}
          </button>
        </div>
      </div>

      <form onSubmit={handleContinue} className="onboarding-card">
        <h2>
          <MailIcon />
          {t("emailNotifications")}
        </h2>
        <p className="onboarding-card-desc">{t("emailNotificationsDesc")}</p>

        <label className="onboarding-notification-option">
          <input
            type="checkbox"
            checked={reminderEnabled}
            onChange={(e) => setReminderEnabled(e.target.checked)}
          />
          <span className="option-label">
            {t("sendReminder")}
            {reminderEnabled && (
              <div className="option-sublabel">
                <select
                  value={reminderHoursBefore}
                  onChange={(e) =>
                    setReminderHoursBefore(Number(e.target.value))
                  }
                  className="onboarding-reminder-select"
                >
                  <option value={1}>{t("reminder1h")}</option>
                  <option value={6}>{t("reminder6h")}</option>
                  <option value={12}>{t("reminder12h")}</option>
                  <option value={24}>{t("reminder24h")}</option>
                </select>
              </div>
            )}
          </span>
        </label>

        <label className="onboarding-notification-option">
          <input
            type="checkbox"
            checked={eventUpdatedEnabled}
            onChange={(e) => setEventUpdatedEnabled(e.target.checked)}
          />
          <span className="option-label">{t("whenEventChanges")}</span>
        </label>

        <label className="onboarding-notification-option">
          <input
            type="checkbox"
            checked={eventCancelledEnabled}
            onChange={(e) => setEventCancelledEnabled(e.target.checked)}
          />
          <span className="option-label">{t("whenEventCancelled")}</span>
        </label>

        <button
          type="submit"
          className="onboarding-continue-btn"
          disabled={saving}
        >
          {saving ? t("saving") : t("continue")}
        </button>
      </form>
    </div>
  );
}
