import { describe, expect, it } from "vitest";
import { normalizeEventDateTime, normalizeUtcDateTime, toUtcIsoFromAbsolute } from "./datetime.js";

describe("datetime helpers", () => {
  it("keeps naive local datetimes without forcing UTC", () => {
    expect(normalizeEventDateTime("2026-07-02 20:00:00")).toBe("2026-07-02T20:00:00");
  });

  it("keeps explicit offset datetimes as absolute inputs", () => {
    expect(normalizeEventDateTime("2026-07-02 20:00:00+02:00")).toBe("2026-07-02T20:00:00+02:00");
  });

  it("converts absolute offset datetimes to UTC ISO", () => {
    expect(toUtcIsoFromAbsolute("2026-07-02T20:00:00+02:00")).toBe("2026-07-02T18:00:00.000Z");
  });

  it("converts RSS pubDate values with timezone to UTC ISO", () => {
    expect(toUtcIsoFromAbsolute("Fri, 05 Apr 2026 18:30:00 +0200")).toBe("2026-04-05T16:30:00.000Z");
  });

  it("normalizes UTC fields by appending Z", () => {
    expect(normalizeUtcDateTime("2026-06-10 20:00:00")).toBe("2026-06-10T20:00:00Z");
  });
});
