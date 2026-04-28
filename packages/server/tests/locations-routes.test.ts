import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { locationRoutes } from "../src/routes/locations.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/api/v1/locations", locationRoutes(db));
  return app;
}

describe("locations routes", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  it("upserts saved locations with null address without duplicates", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u6", "frank");
    const app = makeApp(db, { id: "u6", username: "frank" });

    await app.request("http://localhost/api/v1/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HQ", latitude: 1, longitude: 2 }),
    });
    await app.request("http://localhost/api/v1/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HQ", latitude: 3, longitude: 4 }),
    });

    const rows = db.prepare("SELECT id, latitude FROM saved_locations WHERE account_id = ? AND name = ?").all("u6", "HQ") as Array<{ id: number; latitude: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].latitude).toBe(3);
  });
});
