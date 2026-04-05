import { describe, expect, it } from "vitest";
import {
  buildFromParams,
  buildToParams,
  DateQueryParamError,
  normalizeDateRangeParams,
} from "../src/lib/date-query.js";

describe("date query normalization", () => {
  it("normalizes date-only from to UTC start-of-day", () => {
    expect(buildFromParams("2026-04-13")).toEqual(["2026-04-13T00:00:00.000Z"]);
  });

  it("normalizes date-only to to UTC end-of-day", () => {
    expect(buildToParams("2026-04-13")).toEqual(["2026-04-13T23:59:59.999Z"]);
  });

  it("normalizes offset datetime to canonical UTC ISO", () => {
    expect(buildToParams("2026-04-13T10:30:00+02:00")).toEqual(["2026-04-13T08:30:00.000Z"]);
  });

  it("rejects local datetime without offset", () => {
    expect(() => buildFromParams("2026-04-13T10:30:00")).toThrow(DateQueryParamError);
  });

  it("rejects invalid ranges where from is after to", () => {
    expect(() => normalizeDateRangeParams("2026-04-14", "2026-04-13")).toThrow(DateQueryParamError);
  });
});
