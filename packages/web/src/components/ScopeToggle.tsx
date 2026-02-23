import { useTranslation } from "react-i18next";

export type ScopeFilter = "all" | "feed";

export interface ScopeToggleProps {
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
  /** When false, hide the "feed" / "For me" option (e.g. when user not logged in) */
  showFeedOption?: boolean;
  className?: string;
}

export function ScopeToggle({ value, onChange, showFeedOption = true, className = "" }: ScopeToggleProps) {
  const { t } = useTranslation("events");

  return (
    <div className={`mobile-scope-toggle ${className}`.trim()}>
      <button
        type="button"
        className={`mobile-scope-toggle__btn ${value === "all" ? "mobile-scope-toggle__btn--active" : ""}`}
        onClick={() => onChange("all")}
      >
        {t("allEvents")}
      </button>
      {showFeedOption && (
        <button
          type="button"
          className={`mobile-scope-toggle__btn ${value === "feed" ? "mobile-scope-toggle__btn--active" : ""}`}
          onClick={() => onChange("feed")}
        >
          {t("forMe")}
        </button>
      )}
    </div>
  );
}
