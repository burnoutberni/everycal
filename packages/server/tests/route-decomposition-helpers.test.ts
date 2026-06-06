import { describe, expect, it } from "vitest";
import { buildRemoteTagFilter, paginateMergedFromFetchers } from "../src/routes/events/shared.js";
import { clearSessionCookie, setSessionCookie } from "../src/routes/auth/session-cookies.js";

describe("decomposed route helpers", () => {
  it("keeps remote tag filter response semantics exact-match oriented", () => {
    const filter = buildRemoteTagFilter(["music", "work_shop"]);

    expect(filter.sql).toContain("re.tags = ?");
    expect(filter.sql).toContain("LIKE ? ESCAPE '\\'");
    expect(filter.params).toEqual([
      "music",
      "music,%",
      "%,music,%",
      "%,music",
      "work_shop",
      "work\\_shop,%",
      "%,work\\_shop,%",
      "%,work\\_shop",
    ]);
  });

  it("paginates merged local and remote fetchers with stable cursor boundaries", () => {
    const local = [
      { id: "l1", startAtUtc: "2026-01-01T00:00:00.000Z" },
      { id: "l3", startAtUtc: "2026-01-03T00:00:00.000Z" },
    ];
    const remote = [
      { id: "r2", startAtUtc: "2026-01-02T00:00:00.000Z" },
      { id: "r4", startAtUtc: "2026-01-04T00:00:00.000Z" },
    ];

    const page1 = paginateMergedFromFetchers({
      limit: 2,
      offset: 0,
      fetchLocal: (_after, limit) => local.slice(0, limit),
      fetchRemote: (_after, limit) => remote.slice(0, limit),
    });
    const page2 = paginateMergedFromFetchers({
      limit: 2,
      offset: 0,
      cursor: page1.nextCursor ?? undefined,
      fetchLocal: (after, limit) => local.filter((row) => !after || row.startAtUtc > after.startAtUtc || (row.startAtUtc === after.startAtUtc && row.id > after.id)).slice(0, limit),
      fetchRemote: (after, limit) => remote.filter((row) => !after || row.startAtUtc > after.startAtUtc || (row.startAtUtc === after.startAtUtc && row.id > after.id)).slice(0, limit),
    });

    expect(page1.page.map((event) => event.id)).toEqual(["l1", "r2"]);
    expect(page1.nextCursor).toBeTruthy();
    expect(page2.page.map((event) => event.id)).toEqual(["l3", "r4"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("centralizes auth session cookie formatting without changing names", () => {
    const cookies: string[] = [];
    setSessionCookie({ header: (name, value) => { if (name === "Set-Cookie") cookies.push(value); } }, "token", new Date(Date.now() + 60_000).toISOString());

    expect(cookies.some((cookie) => cookie.includes("everycal_session=token"))).toBe(true);
    expect(cookies.some((cookie) => cookie.includes("everycal_session=token") && cookie.includes("HttpOnly"))).toBe(true);
    expect(cookies.some((cookie) => cookie.includes("everycal_csrf="))).toBe(true);

    const cleared: string[] = [];
    clearSessionCookie({ header: (name, value) => { if (name === "Set-Cookie") cleared.push(value); } });
    expect(cleared.some((cookie) => cookie.includes("everycal_session=") && cookie.includes("Max-Age=0"))).toBe(true);
    expect(cleared.some((cookie) => cookie.includes("everycal_csrf=") && cookie.includes("Max-Age=0"))).toBe(true);
  });
});
