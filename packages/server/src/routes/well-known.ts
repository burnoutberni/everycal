/**
 * Well-known routes for ActivityPub discovery.
 *
 * GET /.well-known/webfinger?resource=acct:username@domain
 * GET /.well-known/nodeinfo
 */

import { Hono } from "hono";
import type { DB } from "../db.js";

export function wellKnownRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/webfinger", (c) => {
    const resource = c.req.query("resource");
    if (!resource) return c.json({ error: "Missing resource parameter" }, 400);

    const match = resource.match(/^acct:([^@]+)@(.+)$/);
    if (!match) return c.json({ error: "Invalid resource format" }, 400);

    const [, username, domain] = match;
    const account = db.prepare("SELECT * FROM accounts WHERE username = ?").get(username);
    if (!account) return c.json({ error: "Account not found" }, 404);

    const baseUrl = process.env.BASE_URL || `https://${domain}`;

    return c.json(
      {
        subject: resource,
        links: [
          {
            rel: "self",
            type: "application/activity+json",
            href: `${baseUrl}/users/${username}`,
          },
        ],
      },
      200,
      { "Content-Type": "application/jrd+json" }
    );
  });

  return router;
}
