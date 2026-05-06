/**
 * Auth routes — register, login, logout, current user, API keys.
 */

import { Hono } from "hono";
import type { DB } from "../db.js";
import { registerApiKeyRoutes } from "./auth/api-keys.js";
import { registerProfileRoutes } from "./auth/profile.js";
import { registerSessionRoutes } from "./auth/session.js";
import { registerVerificationPasswordRoutes } from "./auth/verification-password.js";

export function authRoutes(db: DB): Hono {
  const router = new Hono();

  registerSessionRoutes(router, db);
  registerVerificationPasswordRoutes(router, db);
  registerProfileRoutes(router, db);
  registerApiKeyRoutes(router, db);

  return router;
}
