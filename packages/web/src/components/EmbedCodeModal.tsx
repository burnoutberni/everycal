import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildShowOnEverycalEmbedCode, type EverycalEmbedButtonSize } from "../lib/everycalEmbed";

export function EmbedCodeModal({
  open,
  onClose,
  path,
}: {
  open: boolean;
  onClose: () => void;
  path: string;
}) {
  const { t, i18n } = useTranslation(["common"]);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [buttonSize, setButtonSize] = useState<EverycalEmbedButtonSize>("md");

  const embedCode = useMemo(() => {
    if (typeof window === "undefined") return "";
    return buildShowOnEverycalEmbedCode(path, window.location.origin, buttonSize);
  }, [path, buttonSize]);

  const previewSrcDoc = useMemo(() => {
    if (!embedCode) return "";
    const previewLang = (i18n.resolvedLanguage || i18n.language || "en").toLowerCase();
    return `<!doctype html>
<html lang="${previewLang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
        min-height: 84px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        padding: 0.5rem;
      }
    </style>
  </head>
  <body>
    ${embedCode}
  </body>
</html>`;
  }, [embedCode, i18n.language, i18n.resolvedLanguage]);

  useEffect(() => {
    if (!open) return;
    setCopyStatus("idle");
    setButtonSize("md");
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
          <fieldset className="embed-size-fieldset">
            <legend className="text-sm text-muted" style={{ marginBottom: "0.35rem" }}>{t("embedButtonSizeLabel")}</legend>
            <div className="embed-size-group">
              {([
                { value: "sm", label: t("embedButtonSizeSmall") },
                { value: "md", label: t("embedButtonSizeMedium") },
                { value: "lg", label: t("embedButtonSizeLarge") },
              ] as Array<{ value: EverycalEmbedButtonSize; label: string }>).map((option) => (
                <label
                  key={option.value}
                  className={`embed-size-option ${buttonSize === option.value ? "is-active" : ""}`}
                >
                  <input
                    className="embed-size-control"
                    type="radio"
                    name="embed-size"
                    value={option.value}
                    checked={buttonSize === option.value}
                    onChange={() => setButtonSize(option.value)}
                  />
                  <span className="embed-size-dot" aria-hidden="true" />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <div className="text-sm text-muted" style={{ marginBottom: "0.35rem" }}>{t("embedPreview")}</div>
            {previewSrcDoc ? (
              <iframe
                className="embed-code-preview-frame"
                title={t("embedPreview")}
                srcDoc={previewSrcDoc}
                sandbox="allow-scripts allow-popups"
              />
            ) : (
              <div className="text-sm text-muted">{t("requestFailed")}</div>
            )}
          </div>
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
