import type { Hono } from "hono";
import type { DB } from "../../db.js";
import { createApiKey, requireAuth } from "../../middleware/auth.js";
import { getLocale, t } from "../../lib/i18n.js";
import { parseJsonBody } from "../../lib/request-body.js";

export function registerApiKeyRoutes(router: Hono, db: DB): void {
  // ---- API Keys ----

  // List API keys
  router.get("/api-keys", requireAuth(), (c) => {
    const user = c.get("user")!;
    const rows = db
      .prepare(
        "SELECT id, label, last_used_at, created_at FROM api_keys WHERE account_id = ? ORDER BY created_at DESC"
      )
      .all(user.id) as { id: string; label: string; last_used_at: string | null; created_at: string }[];

    return c.json({
      keys: rows.map((r) => ({
        id: r.id,
        label: r.label,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
      })),
    });
  });

  // Create API key
  router.post("/api-keys", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const parsed = await parseJsonBody<{ label?: string }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;
    const { id, key } = createApiKey(db, user.id, body.label || "Unnamed key");
    return c.json({ id, key, label: body.label || "Unnamed key" }, 201);
  });

  // Delete API key
  router.delete("/api-keys/:id", requireAuth(), (c) => {
    const user = c.get("user")!;
    const keyId = c.req.param("id");
    const result = db
      .prepare("DELETE FROM api_keys WHERE id = ? AND account_id = ?")
      .run(keyId, user.id);
    if (result.changes === 0) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
    return c.json({ ok: true });
  });
}
