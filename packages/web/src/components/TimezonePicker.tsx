import { useMemo } from "react";

const FALLBACK_TIMEZONES = [
  "Europe/Vienna",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];

function supportedTimezones(): string[] {
  try {
    const values = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone");
    if (values && values.length > 0) return values;
  } catch {
    // ignore
  }
  return FALLBACK_TIMEZONES;
}

export function TimezonePicker({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const tzList = useMemo(() => supportedTimezones(), []);
  const datalistId = `${id}-datalist`;

  return (
    <>
      <input
        id={id}
        list={datalistId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || "Europe/Vienna"}
        autoComplete="off"
      />
      <datalist id={datalistId}>
        {tzList.map((tz) => (
          <option key={tz} value={tz} />
        ))}
      </datalist>
    </>
  );
}
