import { getAllowedAdminOrigins } from "./admin-origins.js";
import { requireCsrf } from "./csrf.js";

/** Admin-specific CSRF — delegates to the general {@link requireCsrf} with admin origins. */
export function requireAdminCsrf() {
  return requireCsrf(getAllowedAdminOrigins());
}
