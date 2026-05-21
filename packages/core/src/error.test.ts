import { describe, expect, it } from "vitest";
import { toErrorMessage } from "./error";

describe("toErrorMessage", () => {
  it("returns error.message for Error instances", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns direct strings", () => {
    expect(toErrorMessage("bad request")).toBe("bad request");
  });

  it("returns .message for plain objects", () => {
    expect(toErrorMessage({ message: "failed" })).toBe("failed");
  });

  it("uses fallback for opaque values", () => {
    expect(toErrorMessage({ code: "E_FAIL" })).toBe("Unexpected error");
    expect(toErrorMessage(null, "Request failed")).toBe("Request failed");
  });
});
