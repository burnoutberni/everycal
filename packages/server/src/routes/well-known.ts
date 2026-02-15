/**
 * Well-known routes for ActivityPub discovery.
 *
 * GET /.well-known/webfinger?resource=acct:username@domain
 * GET /.well-known/nodeinfo
 * GET /.well-known/host-meta
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

    // Validate the domain matches our server's domain
    const baseUrl = process.env.BASE_URL || `https://${domain}`;
    const expectedDomain = new URL(baseUrl).hostname;
    if (domain !== expectedDomain) {
      return c.json({ error: "Unknown domain" }, 404);
    }

    const account = db.prepare("SELECT id, username FROM accounts WHERE username = ?").get(username);
    if (!account) return c.json({ error: "Account not found" }, 404);

    return c.json(
      {
        subject: resource,
        aliases: [`${baseUrl}/users/${username}`, `${baseUrl}/@${username}`],
        links: [
          {
            rel: "self",
            type: "application/activity+json",
            href: `${baseUrl}/users/${username}`,
          },
          {
            rel: "http://webfinger.net/rel/profile-page/",
            type: "text/html",
            href: `${baseUrl}/@${username}`,
          },
        ],
      },
      200,
      { "Content-Type": "application/jrd+json; charset=utf-8" }
    );
  });

  router.get("/nodeinfo", (c) => {
    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    return c.json({
      links: [
        {
          rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
          href: `${baseUrl}/nodeinfo/2.0`,
        },
      ],
    });
  });

  router.get("/host-meta", (c) => {
    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    // Escape XML special characters in the base URL
    const safeBaseUrl = baseUrl
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" type="application/xrd+xml" template="${safeBaseUrl}/.well-known/webfinger?resource={uri}"/>
</XRD>`;
    return c.text(xml, 200, { "Content-Type": "application/xrd+xml; charset=utf-8" });
  });

  return router;
}

/**
 * NodeInfo endpoint (separate from .well-known).
 */
export function nodeInfoRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/2.0", (c) => {
    const userCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM accounts").get() as { cnt: number }
    ).cnt;

    const eventCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM events WHERE visibility = 'public'").get() as {
        cnt: number;
      }
    ).cnt;

    return c.json({
      version: "2.0",
      software: {
        name: "everycal",
        version: "0.1.0",
      },
      protocols: ["activitypub"],
      services: {
        inbound: [],
        outbound: [],
      },
      usage: {
        users: {
          total: userCount,
        },
        localPosts: eventCount,
      },
      openRegistrations: process.env.OPEN_REGISTRATIONS !== "false",
      metadata: {
        nodeName: "EveryCal",
        nodeDescription: "Federated event calendar built on ActivityPub",
      },
    });
  });

  return router;
}
