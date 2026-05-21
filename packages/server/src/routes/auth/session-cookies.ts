/** Shared auth session cookie helpers. */

import { nanoid } from "nanoid";

type HeaderTarget = { header: (name: string, value: string, options?: { append?: boolean }) => void };

export function setSessionCookie(c: HeaderTarget, token: string, expiresAt: string) {
  const maxAge = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  const isProduction = process.env.NODE_ENV === "production";
  const sessionParts = [
    `everycal_session=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
  ];
  const csrfParts = [
    `everycal_csrf=${nanoid(32)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
  ];
  if (isProduction) {
    sessionParts.push("Secure");
    csrfParts.push("Secure");
  }
  c.header("Set-Cookie", sessionParts.join("; "));
  c.header("Set-Cookie", csrfParts.join("; "), { append: true });
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
