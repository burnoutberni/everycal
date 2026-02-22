import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { InfoIcon } from "./icons";
import type { ImageAttribution } from "../lib/api";

/** Small icon in corner of header image; click to show license/source attribution (Unsplash/Openverse). */
export function ImageAttributionBadge({
  attribution,
  /** "top-right" avoids overlap with bottom action buttons (e.g. in create flow) */
  position = "bottom-right",
}: {
  attribution: ImageAttribution;
  position?: "top-right" | "bottom-right";
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Format: "Image: [license](licenseUrl) [title](sourceUrl) by [author](creatorUrl)"
  const content = (() => {
    const licenseAbbr = attribution.source === "unsplash"
      ? "Unsplash"
      : attribution.license
        ? `CC ${attribution.license.toUpperCase().replace(/-/g, " ")}`
        : attribution.source === "openverse"
          ? "Openverse"
          : null;
    const licenseUrl = attribution.source === "unsplash"
      ? "https://unsplash.com/license"
      : attribution.licenseUrl;
    const title = attribution.title || t("image");
    const author = attribution.creator || t("unknown");

    const linkStyle = { color: "var(--accent)", textDecoration: "underline" };
    const parts: React.ReactNode[] = [];
    parts.push(t("imagePrefix"));
    if (licenseAbbr && licenseUrl) {
      parts.push(<a key="lic" href={licenseUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>{licenseAbbr}</a>);
    } else if (licenseAbbr) {
      parts.push(licenseAbbr);
    }
    parts.push(" ");
    if (attribution.sourceUrl) {
      parts.push(<a key="title" href={attribution.sourceUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>{title}</a>);
    } else {
      parts.push(title);
    }
    parts.push(t("imageBy"));
    if (attribution.creatorUrl && attribution.creator) {
      parts.push(<a key="author" href={attribution.creatorUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>{author}</a>);
    } else {
      parts.push(author);
    }
    return parts;
  })();

  const isTopRight = position === "top-right";
  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        ...(isTopRight ? { top: "0.5rem", right: "0.5rem" } : { bottom: "0.5rem", right: "0.5rem" }),
        zIndex: 10,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("imageAttribution")}
        title={t("imageLicenseSource")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          padding: 0,
          borderRadius: 11,
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          border: "none",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        <InfoIcon />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            ...(isTopRight
              ? { top: "100%", right: 0, marginTop: "0.35rem" }
              : { bottom: "100%", right: 0, marginBottom: "0.35rem" }),
            padding: "0.5rem 0.75rem",
            background: "rgba(0,0,0,0.85)",
            color: "#fff",
            borderRadius: "var(--radius)",
            fontSize: "0.75rem",
            minWidth: "240px",
            maxWidth: "90vw",
            lineHeight: 1.4,
          }}
        >
          <div style={{ color: "rgba(255,255,255,0.9)" }}>{content}</div>
        </div>
      )}
    </div>
  );
}
