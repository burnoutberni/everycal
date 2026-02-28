const REGISTRATION_USERNAME_PATTERN = /^[a-z0-9_]{2,40}$/;
const IDENTITY_HANDLE_PATTERN = /^[a-z0-9_]{2,40}$/;

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
