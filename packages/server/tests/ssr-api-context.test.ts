import { afterEach, describe, expect, it, vi } from "vitest";
import { auth, createApiRequestContext, type ApiRequestContext } from "../../../packages/web/src/lib/api";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("SSR API request context isolation", () => {
  it("forwards cookies per request context without cross-leakage", async () => {
    const cookiesSeen: string[] = [];

    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      cookiesSeen.push(headers.get("cookie") || "");
      return new Response(
        JSON.stringify({ id: "u1", username: "alice", displayName: "Alice" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const requestA = createApiRequestContext({
      headersOriginal: { cookie: "everycal_session=session-a" },
    });
    const requestB = createApiRequestContext({
      headersOriginal: { cookie: "everycal_session=session-b" },
    });

    await Promise.all([auth.me(requestA), auth.me(requestB)]);

    expect(cookiesSeen).toContain("everycal_session=session-a");
    expect(cookiesSeen).toContain("everycal_session=session-b");
  });

  it("does not forward cookies to non-loopback API origins", async () => {
    const cookiesSeen: Array<string | null> = [];

    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      cookiesSeen.push(headers.get("cookie"));
      return new Response(
        JSON.stringify({ id: "u1", username: "alice", displayName: "Alice" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const context: ApiRequestContext = {
      cookie: "everycal_session=should-not-forward",
      apiOrigin: "https://example.com",
    };

    await auth.me(context);
    expect(cookiesSeen[0]).toBeNull();
  });
});
