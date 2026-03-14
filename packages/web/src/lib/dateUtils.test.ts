import { describe, expect, it } from "vitest";
import { dateToLocalYMD, parseLocalYmdDate, resolveNearestDateKey } from "./dateUtils";

describe("parseLocalYmdDate", () => {
  it("parses valid YYYY-MM-DD", () => {
    const parsed = parseLocalYmdDate("2026-03-14");
    expect(parsed).not.toBeNull();
    expect(dateToLocalYMD(parsed as Date)).toBe("2026-03-14");
  });

  it("returns null for invalid formats", () => {
    expect(parseLocalYmdDate("2026/03/14")).toBeNull();
    expect(parseLocalYmdDate("14-03-2026")).toBeNull();
    expect(parseLocalYmdDate("not-a-date")).toBeNull();
  });

  it("returns null for overflow dates", () => {
    expect(parseLocalYmdDate("2024-02-31")).toBeNull();
    expect(parseLocalYmdDate("2026-13-01")).toBeNull();
    expect(parseLocalYmdDate("2026-00-10")).toBeNull();
  });
});

describe("resolveNearestDateKey", () => {
  it("returns null for empty keys", () => {
    expect(resolveNearestDateKey([], "2026-03-14")).toBeNull();
  });

  it("returns exact match when present", () => {
    const keys = ["2026-03-10", "2026-03-14", "2026-03-20"];
    expect(resolveNearestDateKey(keys, "2026-03-14", true)).toBe("2026-03-14");
    expect(resolveNearestDateKey(keys, "2026-03-14", false)).toBe("2026-03-14");
  });

  it("prefers earlier key by default", () => {
    const keys = ["2026-03-10", "2026-03-14", "2026-03-20"];
    expect(resolveNearestDateKey(keys, "2026-03-15")).toBe("2026-03-14");
  });

  it("prefers later key when preferEarlier=false", () => {
    const keys = ["2026-03-10", "2026-03-14", "2026-03-20"];
    expect(resolveNearestDateKey(keys, "2026-03-15", false)).toBe("2026-03-20");
  });

  it("handles targets before first key", () => {
    const keys = ["2026-03-10", "2026-03-14", "2026-03-20"];
    expect(resolveNearestDateKey(keys, "2026-03-01", true)).toBe("2026-03-10");
    expect(resolveNearestDateKey(keys, "2026-03-01", false)).toBe("2026-03-10");
  });

  it("handles targets after last key", () => {
    const keys = ["2026-03-10", "2026-03-14", "2026-03-20"];
    expect(resolveNearestDateKey(keys, "2026-03-30", true)).toBe("2026-03-20");
    expect(resolveNearestDateKey(keys, "2026-03-30", false)).toBe("2026-03-20");
  });
});
