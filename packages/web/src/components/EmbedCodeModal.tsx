import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildShowOnEverycalEmbedCode } from "../lib/everycalEmbed";

export function EmbedCodeModal({
  open,
  onClose,
  path,
}: {
  open: boolean;
  onClose: () => void;
  path: string;
}) {
  const { t } = useTranslation(["common"]);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  const embedCode = useMemo(() => {
    if (typeof window === "undefined") return "";
    return buildShowOnEverycalEmbedCode(path, window.location.origin);
  }, [path]);

  useEffect(() => {
    if (!open) return;
    setCopyStatus("idle");
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = async () => {
    if (!embedCode || copyStatus === "copying") return;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="embed-code-modal-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-card embed-code-modal-card">
        <div className="modal-header">
          <h2 id="embed-code-modal-title" style={{ fontSize: "1rem", fontWeight: 600 }}>{t("embedCode")}</h2>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} aria-label={t("close")}>✕</button>
        </div>
        <div className="modal-body embed-code-modal-body">
          <p className="text-sm text-muted">{t("embedCodeHint")}</p>
          <textarea
            readOnly
            value={embedCode}
            className="embed-code-textarea"
            aria-label={t("embedCode")}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex gap-1" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn-ghost btn-sm" onClick={onClose}>{t("close")}</button>
            <button type="button" className="btn-primary btn-sm" onClick={handleCopy} disabled={!embedCode || copyStatus === "copying"}>
              {copyStatus === "copied" ? t("copied") : copyStatus === "error" ? t("copyFailed") : copyStatus === "copying" ? t("copying") : t("copyEmbedCode")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
