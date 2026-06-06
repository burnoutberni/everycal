import { FormEvent, ReactNode, useEffect, useId, useRef } from "react";

type ReasonModalProps = {
  open: boolean;
  title: string;
  description: string;
  reasonLabel: string;
  reasonValue: string;
  reasonPlaceholder?: string;
  submitLabel: string;
  cancelLabel: string;
  closeLabel: string;
  error?: string | null;
  submitting?: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  children?: ReactNode;
};

export function ReasonModal({
  open,
  title,
  description,
  reasonLabel,
  reasonValue,
  reasonPlaceholder,
  submitLabel,
  cancelLabel,
  closeLabel,
  error,
  submitting = false,
  onReasonChange,
  onClose,
  onSubmit,
  children,
}: ReasonModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const reasonId = useId();

  useEffect(() => {
    if (!open) return;
    const previousFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

    (reasonRef.current || closeButtonRef.current || dialogRef.current)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!submitting) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first) {
          e.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocused?.isConnected) previousFocused.focus();
    };
  }, [open, onClose, submitting]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="modal-card reason-modal-card" ref={dialogRef} tabIndex={-1}>
        <div className="modal-header">
          <h2 id={titleId} style={{ fontSize: "1rem", fontWeight: 600 }}>{title}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn-ghost btn-sm"
            onClick={onClose}
            disabled={submitting}
            aria-label={closeLabel}
          >
            ✕
          </button>
        </div>
        <form className="modal-body reason-modal-body" onSubmit={onSubmit}>
          <p id={descriptionId} className="text-sm text-muted">{description}</p>
          {children}
          <label htmlFor={reasonId} className="text-sm text-muted">{reasonLabel}</label>
          <textarea
            id={reasonId}
            ref={reasonRef}
            value={reasonValue}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder={reasonPlaceholder}
            rows={5}
            maxLength={2000}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : descriptionId}
          />
          {error ? <p id={errorId} className="error-text" role="alert">{error}</p> : null}
          <div className="reason-modal-actions">
            <button type="button" className="btn-ghost btn-sm" disabled={submitting} onClick={onClose}>{cancelLabel}</button>
            <button type="submit" className="btn-primary btn-sm" disabled={submitting}>{submitLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
