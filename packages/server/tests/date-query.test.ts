import { describe, expect, it } from "vitest";
import {
  buildDateRangeFilter,
  buildFromParams,
  buildToParams,
  DateQueryParamError,
  normalizeDateRangeParams,
  parseDateRangeParams,
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

  it("rejects invalid date-only calendar values", () => {
    expect(() => buildFromParams("2026-02-30")).toThrow(DateQueryParamError);
    expect(() => buildToParams("2026-13-01")).toThrow(DateQueryParamError);
  });

  it("rejects invalid ranges where from is after to", () => {
    expect(() => normalizeDateRangeParams("2026-04-14", "2026-04-13")).toThrow(DateQueryParamError);
  });

  it("builds date-column filters for date-only bounds", () => {
    const filter = buildDateRangeFilter(
      { instantColumn: "e.start_at_utc", dateColumn: "e.start_on" },
      "2026-04-13",
      "2026-04-14",
    );
    expect(filter.sql).toBe(" AND e.start_on >= ? AND e.start_on <= ?");
    expect(filter.params).toEqual(["2026-04-13", "2026-04-14"]);
  });

  it("builds instant-column filters for datetime bounds", () => {
    const filter = buildDateRangeFilter(
      { instantColumn: "e.start_at_utc", dateColumn: "e.start_on" },
      "2026-04-13T10:30:00+02:00",
      undefined,
    );
    expect(filter.sql).toBe(" AND e.start_at_utc >= ?");
    expect(filter.params).toEqual(["2026-04-13T08:30:00.000Z"]);
  });

  it("keeps parsed bound kind for date-only vs instant", () => {
    const parsed = parseDateRangeParams("2026-04-13", "2026-04-13T10:30:00+02:00");
    expect(parsed.from?.kind).toBe("date");
    expect(parsed.to?.kind).toBe("instant");
  });
});
