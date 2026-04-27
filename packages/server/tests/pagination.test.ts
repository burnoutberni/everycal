import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { PaginationParamError, parseLimitOffset } from "../src/lib/pagination.js";

describe("pagination", () => {
  it("rejects invalid values and applies caps", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      try {
        const parsed = parseLimitOffset(c, { defaultLimit: 12, maxLimit: 30 });
        return c.json(parsed);
      } catch (error) {
        if (error instanceof PaginationParamError) return c.json({ error: error.message }, 400);
        throw error;
      }
    });

    const capped = await app.request("http://localhost/?limit=999");
    expect(capped.status).toBe(200);
    await expect(capped.json()).resolves.toEqual({ limit: 30, offset: 0 });

    const invalid = await app.request("http://localhost/?limit=-1");
    expect(invalid.status).toBe(400);
  });
});
