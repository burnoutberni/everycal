const REGISTRATION_USERNAME_PATTERN = /^[a-z0-9_]{2,40}$/;
const IDENTITY_HANDLE_PATTERN = /^[a-z0-9_]{2,40}$/;
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_PATTERN = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);

type HttpUrlValidationOptions = {
  allowLocalhost?: boolean;
  allowPrivateHosts?: boolean;
};

function isIPv4Literal(host: string): boolean {
  return IPV4_PATTERN.test(host);
}

function isIPv6Literal(host: string): boolean {
  return host.includes(":") && /^[0-9a-f:]+$/i.test(host);
}

function isPrivateIPv4Literal(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 18) return true;
  if (a === 198 && b === 19) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6Literal(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "::"
    || lower === "::1"
    || lower.startsWith("fc")
    || lower.startsWith("fd")
    || lower.startsWith("fe8")
    || lower.startsWith("fe9")
    || lower.startsWith("fea")
    || lower.startsWith("feb")
    || lower.startsWith("2001:db8");
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

export function isValidHttpUrl(input: string, options: HttpUrlValidationOptions = {}): boolean {
  const { allowLocalhost = false, allowPrivateHosts = false } = options;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) return false;
    if (host === "localhost") return allowLocalhost;
    if (isIPv4Literal(host)) return allowPrivateHosts || !isPrivateIPv4Literal(host);
    if (isIPv6Literal(host)) return allowPrivateHosts || !isPrivateIPv6Literal(host);
    return host.includes(".") && !host.startsWith(".") && !host.endsWith(".");
  } catch {
    return false;
  }
}
