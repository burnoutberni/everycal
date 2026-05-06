/** Shared auth session cookie helpers. */

export function setSessionCookie(c: { header: (name: string, value: string) => void }, token: string, expiresAt: string) {
  const maxAge = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [
    `everycal_session=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
  ];
  if (isProduction) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(c: { header: (name: string, value: string) => void }) {
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [
    "everycal_session=",
    "HttpOnly",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (isProduction) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "));
}
