import type { DB } from "../db.js";
import { getBaseUrl } from "../lib/base-url.js";
import { isProduction } from "../lib/env.js";
import { getEffectiveSetting } from "../lib/runtime-settings.js";

const DEV_ADMIN_ORIGIN = "http://localhost:5173";

function addOrigin(origins: Set<string>, value: string | null | undefined): void {
  if (!value) return;
  for (const rawOrigin of value.split(",")) {
    const trimmed = rawOrigin.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignore invalid configured origins.
    }
  }
}

export function getAllowedAdminOrigins(db?: DB): Set<string> {
  const origins = new Set<string>();

  try {
    origins.add(new URL(getBaseUrl()).origin);
  } catch {
    // Leave the set empty when BASE_URL is invalid or unavailable.
  }

  addOrigin(origins, db ? getEffectiveSetting<string>(db, "cors_origin", "") : process.env.CORS_ORIGIN);

  if (!isProduction()) {
    origins.add(DEV_ADMIN_ORIGIN);
  }

  return origins;
}

export function isAllowedAdminOrigin(origin: string | null, db?: DB): boolean {
  return origin !== null && getAllowedAdminOrigins(db).has(origin);
}
