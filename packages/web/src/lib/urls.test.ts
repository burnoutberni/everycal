import { describe, expect, it } from "vitest";
import { eventPath, remoteEventResolvePath } from "./urls";

describe("remote event URL helpers", () => {
  it("builds frontend resolver path instead of API path", () => {
    expect(remoteEventResolvePath("https://remote.example/events/99")).toBe(
      "/r/event?uri=https%3A%2F%2Fremote.example%2Fevents%2F99"
    );
  });

  it("falls back to frontend resolver for remote events without slug", () => {
    expect(eventPath({
      id: "https://remote.example/events/99",
      source: "remote",
      account: null,
    })).toBe("/r/event?uri=https%3A%2F%2Fremote.example%2Fevents%2F99");
  });
});
