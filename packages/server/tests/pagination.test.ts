import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { PaginationParamError, parseLimitOffset, parsePageOrDefault } from "../src/lib/pagination.js";

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

  it("parses page strictly and defaults invalid values to 1", () => {
    expect(parsePageOrDefault(undefined)).toBe(1);
    expect(parsePageOrDefault("1")).toBe(1);
    expect(parsePageOrDefault("3")).toBe(3);
    expect(parsePageOrDefault("0")).toBe(1);
    expect(parsePageOrDefault("-4")).toBe(1);
    expect(parsePageOrDefault("abc")).toBe(1);
    expect(parsePageOrDefault("2abc")).toBe(1);
    expect(parsePageOrDefault("9007199254740992")).toBe(1);
  });
});
