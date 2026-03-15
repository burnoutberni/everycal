import { describe, expect, it } from "vitest";
import { rowToEvent } from "../src/lib/feed-event.js";

describe("rowToEvent", () => {
  const baseRow = {
    id: "e1",
    title: "Event",
    start_date: "2026-03-15",
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-02T00:00:00.000Z",
  };

  it("preserves valid non-public visibility", () => {
    const event = rowToEvent({ ...baseRow, visibility: "followers_only" });
    expect(event.visibility).toBe("followers_only");
  });

  it("falls back to public for invalid visibility values", () => {
    const event = rowToEvent({ ...baseRow, visibility: "friends_only" });
    expect(event.visibility).toBe("public");
  });
});
