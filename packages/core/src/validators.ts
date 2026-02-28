const REGISTRATION_USERNAME_PATTERN = /^[a-z0-9_]{2,40}$/;
const IDENTITY_HANDLE_PATTERN = /^[a-z0-9_]{2,40}$/;
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_PATTERN = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);

function isIPv4Literal(host: string): boolean {
  return IPV4_PATTERN.test(host);
}

function isIPv6Literal(host: string): boolean {
  return host.includes(":") && /^[0-9a-f:]+$/i.test(host);
}

export function normalizeHandle(raw: string): string {
  return raw.toLowerCase().trim();
}

export function isValidRegistrationUsername(username: string): boolean {
  return REGISTRATION_USERNAME_PATTERN.test(username);
}

export function isValidIdentityHandle(username: string): boolean {
  if (username.includes("@")) return false;
  if (/\s/.test(username)) return false;
  return IDENTITY_HANDLE_PATTERN.test(username);
}

export function normalizeHttpUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function isValidHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) return false;
    if (isIPv4Literal(host) || isIPv6Literal(host)) return true;
    return host.includes(".") && !host.startsWith(".") && !host.endsWith(".");
  } catch {
    return false;
  }
}
