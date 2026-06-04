import { FormEvent, useState } from "react";
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
      setError("Reason is required for moderation actions");
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
      setError(toErrorMessage(err, "Failed to moderate event"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="moderation-decision-actions">
        <button type="button" className={`btn btn-primary${buttonSizeClass}`} onClick={() => setOpen(true)}>Moderate event</button>
      </div>
      <ReasonModal
        open={open}
        title={`Moderate event: ${eventTitle || eventId}`}
        description="This decision changes event visibility. It does not edit the moderation note itself."
        reasonLabel={decision === "hidden" ? "Removal reason" : "Keep reason"}
        reasonValue={reason}
        reasonPlaceholder={decision === "hidden" ? "Explain why this event should be removed..." : "Explain why this event should remain visible..."}
        submitLabel={submitting ? "Saving..." : decision === "hidden" ? "Remove event" : "Keep event"}
        cancelLabel="Cancel"
        closeLabel="Close"
        error={error}
        submitting={submitting}
        onReasonChange={setReason}
        onClose={closeModal}
        onSubmit={submit}
      >
        <div className="moderation-decision-state-toggle" role="group" aria-label="Moderation decision">
          <button
            type="button"
            className={`btn btn-sm ${decision === "hidden" ? "btn-danger" : "btn-ghost"}`}
            onClick={() => setDecision("hidden")}
            disabled={submitting}
          >
            Remove event
          </button>
          <button
            type="button"
            className={`btn btn-sm ${decision === "visible" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setDecision("visible")}
            disabled={submitting}
          >
            Keep event
          </button>
        </div>
      </ReasonModal>
    </>
  );
}
