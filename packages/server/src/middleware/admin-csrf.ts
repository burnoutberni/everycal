import type { DB } from "../db.js";
import { getAllowedAdminOrigins } from "./admin-origins.js";
import { requireCsrf } from "./csrf.js";

/** Admin-specific CSRF — delegates to the general {@link requireCsrf} with admin origins. */
export function requireAdminCsrf(db: DB) {
  return requireCsrf(getAllowedAdminOrigins(db));
}
