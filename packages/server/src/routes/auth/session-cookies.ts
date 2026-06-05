/** Shared auth session cookie helpers. */

import { nanoid } from "nanoid";

type HeaderTarget = { header: (name: string, value: string, options?: { append?: boolean }) => void };

function readCookie(headerValue: string | undefined, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = (headerValue || "").match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return match?.[1] ?? null;
}

function toMaxAgeSeconds(expiresAt: string): number {
  const normalized = expiresAt.includes("T") ? expiresAt : `${expiresAt.replace(" ", "T")}Z`;
  return Math.max(0, Math.floor((new Date(normalized).getTime() - Date.now()) / 1000));
}

function buildCsrfCookie(expiresAt: string): string {
  const parts = [
    `everycal_csrf=${nanoid(32)}`,
    "Path=/",
    `Max-Age=${toMaxAgeSeconds(expiresAt)}`,
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function setCsrfCookie(c: HeaderTarget, expiresAt: string) {
  c.header("Set-Cookie", buildCsrfCookie(expiresAt), { append: true });
}

export function maybeSetMissingCsrfCookie(c: HeaderTarget, cookieHeader: string | undefined, expiresAt: string | null | undefined) {
  if (!expiresAt) return;
  if (!readCookie(cookieHeader, "everycal_session")) return;
  if (readCookie(cookieHeader, "everycal_csrf")) return;
  setCsrfCookie(c, expiresAt);
}

export function setSessionCookie(c: HeaderTarget, token: string, expiresAt: string) {
  const maxAge = toMaxAgeSeconds(expiresAt);
  const isProduction = process.env.NODE_ENV === "production";
  const sessionParts = [
    `everycal_session=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
  ];
  if (isProduction) {
    sessionParts.push("Secure");
  }
  c.header("Set-Cookie", sessionParts.join("; "));
  setCsrfCookie(c, expiresAt);
}

export function clearSessionCookie(c: HeaderTarget) {
  const isProduction = process.env.NODE_ENV === "production";
  const sessionParts = [
    "everycal_session=",
    "HttpOnly",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  const csrfParts = [
    "everycal_csrf=",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (isProduction) {
    sessionParts.push("Secure");
    csrfParts.push("Secure");
  }
  c.header("Set-Cookie", sessionParts.join("; "));
  c.header("Set-Cookie", csrfParts.join("; "), { append: true });
}
