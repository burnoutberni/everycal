/**
 * EveryCal logo — abstract icon mark + wordmark.
 * Warm amber palette: confident, friendly, "take over the world" vibe.
 */

export function LogoIcon({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="16" r="10" style={{ fill: "var(--brand)" }} />
      <circle cx="20" cy="16" r="10" style={{ fill: "var(--brand-light)", fillOpacity: 0.9 }} />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
      <LogoIcon size={22} />
      <span style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em" }}>
        EveryCal
      </span>
    </span>
  );
}
