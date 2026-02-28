import { describe, expect, it } from "vitest";
import { resolvePostAsAccountId } from "./postAs";

describe("NewEventPage post-as recovery logic", () => {
  it("falls back to the user account when draft postAsAccountId is stale", () => {
    const allowed = new Set(["owner", "identity1"]);
    const resolved = resolvePostAsAccountId("identity-old", "owner", allowed);
    expect(resolved).toBe("owner");
  });

  it("keeps valid selected identity", () => {
    const allowed = new Set(["owner", "identity1"]);
    const resolved = resolvePostAsAccountId("identity1", "owner", allowed);
    expect(resolved).toBe("identity1");
  });
});
