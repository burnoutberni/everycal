import type { ReactNode } from "react";
import { formatDateHeading, parseLocalYmdDate } from "../lib/dateUtils";

interface DateEventSectionProps {
  dateKey: string;
  locale: string;
  isPast?: boolean;
  pastLabel?: string;
  pastLabelClassName?: string;
  sectionClassName?: string;
  setSectionRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}

export function DateEventSection({
  dateKey,
  locale,
  isPast = false,
  pastLabel,
  pastLabelClassName,
  sectionClassName,
  setSectionRef,
  children,
}: DateEventSectionProps) {
  const parsedDate = parseLocalYmdDate(dateKey);

  return (
    <div
      ref={setSectionRef}
      data-date={dateKey}
      className={sectionClassName}
      style={{ marginBottom: "1.25rem" }}
    >
      <h2
        className="text-sm"
        style={{
          fontWeight: 600,
          color: isPast ? "var(--text-dim)" : "var(--text-muted)",
          marginBottom: "0.4rem",
          borderBottom: "1px solid var(--border)",
          paddingBottom: "0.3rem",
        }}
      >
        {isPast && pastLabel && <span className={pastLabelClassName}>{pastLabel} — </span>}
        {parsedDate ? formatDateHeading(parsedDate, locale) : dateKey}
      </h2>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
