import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedConsoleLog,
  configureBoundedLogForTests,
  getBoundedLogStateKeysForTests,
  resetBoundedLogStateForTests,
} from "../src/lib/bounded-log.js";

afterEach(() => {
  vi.useRealTimers();
  resetBoundedLogStateForTests();
});

describe("boundedConsoleLog", () => {
  it("prunes stale entries during writes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    boundedConsoleLog("old", "old msg", { windowMs: 1000 });
    vi.setSystemTime(new Date("2026-05-01T00:00:00.500Z"));
    boundedConsoleLog("fresh", "fresh msg", { windowMs: 10_000 });

    expect(getBoundedLogStateKeysForTests()).toEqual(["old", "fresh"]);

    vi.setSystemTime(new Date("2026-05-01T00:00:01.500Z"));
    boundedConsoleLog("new", "new msg", { windowMs: 10_000 });

    expect(getBoundedLogStateKeysForTests()).toEqual(["fresh", "new"]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("evicts least recently used key when max entries is exceeded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));

    configureBoundedLogForTests({ maxEntries: 3 });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    boundedConsoleLog("a", "a", { windowMs: 60_000 });
    boundedConsoleLog("b", "b", { windowMs: 60_000 });
    boundedConsoleLog("c", "c", { windowMs: 60_000 });

    boundedConsoleLog("a", "a", { windowMs: 60_000 });
    boundedConsoleLog("d", "d", { windowMs: 60_000 });

    expect(getBoundedLogStateKeysForTests()).toEqual(["c", "a", "d"]);
    expect(warnSpy).toHaveBeenCalledTimes(4);
    warnSpy.mockRestore();
  });
});
