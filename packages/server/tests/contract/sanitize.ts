type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

const VOLATILE_KEY = /(id|token|secret|hash|createdAt|updatedAt|expiresAt|atUtc|timestamp)$/i;

export function sanitizeForContractSnapshot<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (typeof value !== "object") return String(value);

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (VOLATILE_KEY.test(key)) {
      return [key, "<redacted>"];
    }
    return [key, sanitizeValue(entry)];
  });
  return Object.fromEntries(entries) as JsonValue;
}
