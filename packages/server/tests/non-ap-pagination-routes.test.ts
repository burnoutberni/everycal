import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/db.js";
import { userRoutes } from "../src/routes/users.js";
import { directoryRoutes } from "../src/routes/directory.js";

function createApp() {
  const db = initDatabase(":memory:");
  const app = new Hono();
  app.route("/api/v1/users", userRoutes(db));
  app.route("/api/v1", directoryRoutes(db));
  db.prepare("INSERT INTO accounts (id, username, account_type, discoverable) VALUES (?, ?, 'person', 1)").run("u1", "alice");
  return { app };
}

describe("non-ActivityPub pagination parsing", () => {
  it("rejects invalid users limit with shared parser behavior", async () => {
    const { app } = createApp();
    const res = await app.request("http://localhost/api/v1/users?limit=-4");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("limit");
  });

  it("rejects invalid directory offset with shared parser behavior", async () => {
    const { app } = createApp();
    const res = await app.request("http://localhost/api/v1/directory?offset=-1");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("offset");
  });
});
