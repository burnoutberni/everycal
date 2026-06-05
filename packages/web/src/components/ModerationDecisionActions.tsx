import { FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { toErrorMessage } from "@everycal/core";
import { adminFetch } from "../lib/adminFetch";
import { ReasonModal } from "./ReasonModal";

type DecisionState = "hidden" | "visible";

export function ModerationDecisionActions({
  eventId,
  eventTitle,
  onResolved,
  size = "sm",
}: {
  eventId: string;
  eventTitle?: string | null;
  onResolved?: (state: DecisionState) => Promise<void> | void;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation(["events", "common"]);
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<DecisionState>("hidden");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonSizeClass = size === "md" ? "" : " btn-sm";

  const resetAndCloseModal = () => {
    setOpen(false);
    setReason("");
    setError(null);
    setDecision("hidden");
  };

  const closeModal = () => {
    if (submitting) return;
    resetAndCloseModal();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(t("moderationReasonRequired"));
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      await adminFetch(`/api/v1/admin/events/${encodeURIComponent(eventId)}/moderate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: decision, reason: trimmed }),
      });
      await onResolved?.(decision);
      resetAndCloseModal();
    } catch (err) {
      setError(toErrorMessage(err, t("moderationRequestFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="moderation-decision-actions">
        <button type="button" className={`btn btn-primary${buttonSizeClass}`} onClick={() => setOpen(true)}>{t("moderateEvent")}</button>
      </div>
      <ReasonModal
        open={open}
        title={t("moderateEventTitle", { title: eventTitle || eventId })}
        description={t("moderationDecisionDescription")}
        reasonLabel={decision === "hidden" ? t("moderationRemovalReason") : t("moderationKeepReason")}
        reasonValue={reason}
        reasonPlaceholder={decision === "hidden" ? t("moderationRemovalReasonPlaceholder") : t("moderationKeepReasonPlaceholder")}
        submitLabel={submitting ? t("common:saving") : decision === "hidden" ? t("moderationRemoveEvent") : t("moderationKeepEvent")}
        cancelLabel={t("common:cancel")}
        closeLabel={t("common:close")}
        error={error}
        submitting={submitting}
        onReasonChange={setReason}
        onClose={closeModal}
        onSubmit={submit}
      >
        <div className="moderation-decision-state-toggle" role="group" aria-label={t("moderationDecisionAriaLabel")}>
          <button
            type="button"
            className={`btn btn-sm ${decision === "hidden" ? "btn-danger" : "btn-ghost"}`}
            onClick={() => setDecision("hidden")}
            disabled={submitting}
          >
            {t("moderationRemoveEvent")}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${decision === "visible" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setDecision("visible")}
            disabled={submitting}
          >
            {t("moderationKeepEvent")}
          </button>
        </div>
      </ReasonModal>
    </>
  );
}
