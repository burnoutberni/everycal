import { useMemo } from "react";

interface MiniCalendarProps {
  /** Currently selected date */
  selected: Date;
  /** Callback when a date is clicked */
  onSelect: (date: Date) => void;
  /** Set of YYYY-MM-DD strings that have events */
  eventDates?: Set<string>;
}

const DAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function MiniCalendar({ selected, onSelect, eventDates }: MiniCalendarProps) {
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const today = new Date();

  const weeks = useMemo(() => {
    const first = new Date(year, month, 1);
    // Monday = 0, Sunday = 6
    let startDay = first.getDay() - 1;
    if (startDay < 0) startDay = 6;

    const rows: Date[][] = [];
    let current = new Date(year, month, 1 - startDay);

    for (let w = 0; w < 6; w++) {
      const week: Date[] = [];
      for (let d = 0; d < 7; d++) {
        week.push(new Date(current));
        current.setDate(current.getDate() + 1);
      }
      rows.push(week);
      // Stop if we've gone past this month
      if (week[0].getMonth() > month && week[0].getFullYear() >= year) break;
    }
    return rows;
  }, [year, month]);

  const prevMonth = () => onSelect(new Date(year, month - 1, 1));
  const nextMonth = () => onSelect(new Date(year, month + 1, 1));
  const goToday = () => onSelect(new Date());

  const monthLabel = selected.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div style={{ userSelect: "none" }}>
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: "0.5rem" }}>
        <button
          className="btn-ghost btn-sm"
          onClick={prevMonth}
          style={{ padding: "0.2rem 0.5rem", lineHeight: 1 }}
        >
          ‹
        </button>
        <button
          className="btn-ghost btn-sm"
          onClick={goToday}
          style={{ fontSize: "0.8rem", fontWeight: 600 }}
        >
          {monthLabel}
        </button>
        <button
          className="btn-ghost btn-sm"
          onClick={nextMonth}
          style={{ padding: "0.2rem 0.5rem", lineHeight: 1 }}
        >
          ›
        </button>
      </div>

      {/* Day headers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 0, textAlign: "center" }}>
        {DAY_NAMES.map((d) => (
          <div
            key={d}
            style={{ fontSize: "0.7rem", color: "var(--text-dim)", padding: "0.2rem 0", fontWeight: 600 }}
          >
            {d}
          </div>
        ))}

        {/* Days */}
        {weeks.flatMap((week) =>
          week.map((day) => {
            const isCurrentMonth = day.getMonth() === month;
            const isToday = sameDay(day, today);
            const isSelected = sameDay(day, selected);
            const hasEvents = eventDates?.has(toYMD(day));

            return (
              <button
                key={day.toISOString()}
                onClick={() => onSelect(day)}
                style={{
                  background: isSelected
                    ? "var(--accent)"
                    : isToday
                      ? "var(--bg-hover)"
                      : "transparent",
                  color: isSelected
                    ? "#000"
                    : !isCurrentMonth
                      ? "var(--text-dim)"
                      : "var(--text)",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  padding: "0.3rem 0",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                  fontWeight: isToday || isSelected ? 700 : 400,
                  position: "relative",
                }}
              >
                {day.getDate()}
                {hasEvents && !isSelected && (
                  <span
                    style={{
                      position: "absolute",
                      bottom: 1,
                      left: "50%",
                      transform: "translateX(-50%)",
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      background: "var(--accent)",
                    }}
                  />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
