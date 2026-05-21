import { FormEvent, useState } from "react";
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

  const closeModal = () => {
    if (submitting) return;
    setOpen(false);
    setReason("");
    setError(null);
    setDecision("hidden");
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
      const res = await fetch(`/api/v1/admin/events/${encodeURIComponent(eventId)}/moderate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: decision, reason: trimmed }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      await onResolved?.(decision);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
