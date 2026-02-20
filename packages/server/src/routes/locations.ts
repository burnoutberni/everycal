import { Hono } from "hono";
import type { DB } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

export function locationRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/", requireAuth(), (c) => {
    const user = c.get("user")!;
    const rows = db
      .prepare(
        `SELECT id, name, address, latitude, longitude, used_at
         FROM saved_locations
         WHERE account_id = ?
         ORDER BY used_at DESC
         LIMIT 20`
      )
      .all(user.id) as {
      id: number;
      name: string;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
      used_at: string;
    }[];

    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        address: r.address,
        latitude: r.latitude,
        longitude: r.longitude,
        usedAt: r.used_at,
      }))
    );
  });

  router.post("/", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{
      name: string;
      address?: string;
      latitude?: number;
      longitude?: number;
    }>();

    if (!body.name) {
      return c.json({ error: "Name is required" }, 400);
    }

    db.prepare(
      `INSERT INTO saved_locations (account_id, name, address, latitude, longitude, used_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, name, address) DO UPDATE SET
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         used_at = datetime('now')`
    ).run(user.id, body.name, body.address || null, body.latitude ?? null, body.longitude ?? null);

    return c.json({ ok: true }, 201);
  });

  router.delete("/:id", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const idNum = parseInt(id, 10);
    if (isNaN(idNum)) {
      return c.json({ error: "Invalid id" }, 400);
    }
    const result = db
      .prepare(
        `DELETE FROM saved_locations WHERE id = ? AND account_id = ?`
      )
      .run(idNum, user.id);
    if (result.changes === 0) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return router;
}
