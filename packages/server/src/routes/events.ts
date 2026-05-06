/**
 * Event API routes.
 */

import { Hono } from "hono";
import type { DB } from "../db.js";
import { createEventRouteContext } from "./events/context.js";
import { registerEventReadRoutes } from "./events/read.js";
import { registerEventSocialRoutes } from "./events/social.js";
import { registerEventSyncRoutes } from "./events/sync.js";
import { registerEventWriteRoutes } from "./events/write.js";

export function eventRoutes(db: DB): Hono {
  const router = new Hono();
  const context = createEventRouteContext(db);

  registerEventReadRoutes(router, db, context);
  registerEventSocialRoutes(router, db);
  registerEventSyncRoutes(router, db);
  registerEventWriteRoutes(router, db, context);

  return router;
}
