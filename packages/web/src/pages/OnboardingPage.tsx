import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../hooks/useAuth";
import { auth as authApi, feeds as feedsApi } from "../lib/api";
import { CalendarSubscribeButtons } from "../components/CalendarSubscribeButtons";
import { CalendarIcon, CheckIcon, LinkIcon, MailIcon } from "../components/icons";

export function OnboardingPage() {
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
      <h1>Get set up in two steps</h1>
      <p className="onboarding-subtitle">
        Put your events in your calendar and choose how you want to stay in the loop.
      </p>

      <div className="onboarding-steps" role="progressbar" aria-label="Setup progress: 2 steps">
        <div
          className="onboarding-step-dot active"
          title="Add to calendar"
          aria-hidden
        />
        <div className="onboarding-step-connector" aria-hidden />
        <div
          className="onboarding-step-dot active"
          title="Notifications"
          aria-hidden
        />
      </div>

      <div className="onboarding-card">
        <h2>
          <CalendarIcon />
          Add your events to your local calendar
        </h2>
        <p className="onboarding-card-desc">
        Select your calendar app below to add your EveryCal feed. Once connected, any events you mark as “Going” or “Maybe” will automatically appear in your calendar.
        </p>
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
            {copyStatus === "copied" && "Copied!"}
            {copyStatus === "error" && "Copy failed — try again"}
            {copyStatus === "copying" && "Copying…"}
            {copyStatus === "idle" && "Copy link instead"}
          </button>
        </div>
      </div>

      <form onSubmit={handleContinue} className="onboarding-card">
        <h2>
          <MailIcon />
          Email notifications
        </h2>
        <p className="onboarding-card-desc">
          We can send you reminders and updates about events you're attending.
        </p>

        <label className="onboarding-notification-option">
          <input
            type="checkbox"
            checked={reminderEnabled}
            onChange={(e) => setReminderEnabled(e.target.checked)}
          />
          <span className="option-label">
            Send reminder before events
            {reminderEnabled && (
              <div className="option-sublabel">
                <select
                  value={reminderHoursBefore}
                  onChange={(e) =>
                    setReminderHoursBefore(Number(e.target.value))
                  }
                  className="onboarding-reminder-select"
                >
                  <option value={1}>1 hour before</option>
                  <option value={6}>6 hours before</option>
                  <option value={12}>12 hours before</option>
                  <option value={24}>24 hours before</option>
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
          <span className="option-label">When an event's time or details change</span>
        </label>

        <label className="onboarding-notification-option">
          <input
            type="checkbox"
            checked={eventCancelledEnabled}
            onChange={(e) => setEventCancelledEnabled(e.target.checked)}
          />
          <span className="option-label">When an event is cancelled</span>
        </label>

        <button
          type="submit"
          className="onboarding-continue-btn"
          disabled={saving}
        >
          {saving ? "Saving…" : "Continue to EveryCal"}
        </button>
      </form>
    </div>
  );
}
