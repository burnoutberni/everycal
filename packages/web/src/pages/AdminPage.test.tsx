// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  authStatus: "anonymous" as "unknown" | "authenticated" | "anonymous",
  loading: false,
  user: null as { isAdmin?: boolean } | null,
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/admin", mocks.navigate],
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: mocks.user,
    authStatus: mocks.authStatus,
    loading: mocks.loading,
  }),
}));

let AdminPage: (typeof import("./AdminPage"))["AdminPage"];

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("AdminPage access redirects", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authStatus = "anonymous";
    mocks.loading = false;
    mocks.user = null;
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    ({ AdminPage } = await import("./AdminPage"));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("redirects anonymous users to login with next path", async () => {
    mocks.authStatus = "anonymous";
    mocks.loading = false;
    mocks.user = null;

    render(<AdminPage />);

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith("/login?next=%2Fadmin&notice=admin-required");
    });
  });

  it("redirects authenticated non-admin users to settings notice", async () => {
    mocks.authStatus = "authenticated";
    mocks.loading = false;
    mocks.user = { isAdmin: false };

    render(<AdminPage />);

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith("/settings?notice=admin-required");
    });
  });

  it("shows a loading state while auth is unresolved", () => {
    mocks.authStatus = "unknown";
    mocks.loading = true;
    mocks.user = null;

    render(<AdminPage />);

    expect(screen.getByRole("heading", { name: "Loading" })).not.toBeNull();
    expect(screen.getByText("Checking admin access...")).not.toBeNull();
    expect(screen.queryByText("Admin access is required.")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe("AdminPage admin fetch errors", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authStatus = "authenticated";
    mocks.loading = false;
    mocks.user = { isAdmin: true };
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/api/v1/admin/audit-log")) {
        return Promise.resolve(jsonResponse({ error: "common.forbidden" }, { status: 403 }));
      }
      return Promise.resolve(jsonResponse({ items: [] }, { status: 200 }));
    }));
    ({ AdminPage } = await import("./AdminPage"));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the server error with HTTP status when admin data refresh fails", async () => {
    render(<AdminPage />);

    expect(await screen.findByRole("heading", { name: "Error" })).not.toBeNull();
    expect(screen.getByText("common.forbidden (403)")).not.toBeNull();
  });

  it("falls back to a generic status error when no server error is provided", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/api/v1/admin/audit-log")) {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return Promise.resolve(jsonResponse({ items: [] }, { status: 200 }));
    }));

    render(<AdminPage />);

    expect(await screen.findByRole("heading", { name: "Error" })).not.toBeNull();
    expect(screen.getByText("Request failed (401)")).not.toBeNull();
  });
});

describe("AdminPage audit payload rendering", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authStatus = "authenticated";
    mocks.loading = false;
    mocks.user = { isAdmin: true };
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/api/v1/admin/audit-log")) {
        return Promise.resolve(jsonResponse({
          items: [
            {
              id: "audit-valid",
              admin_account_id: "admin-1",
              action_type: "account.disable",
              target_type: "account",
              target_id: "user-1",
              payload_json: '{"reason":"spam","count":2}',
              created_at: "2026-06-03T12:00:00.000Z",
            },
            {
              id: "audit-invalid",
              admin_account_id: "admin-1",
              action_type: "account.enable",
              target_type: "account",
              target_id: "user-2",
              payload_json: "{invalid json",
              created_at: "2026-06-03T12:00:01.000Z",
            },
            {
              id: "audit-empty",
              admin_account_id: "admin-1",
              action_type: "security.auth.revoke",
              target_type: "account",
              target_id: "user-3",
              payload_json: "",
              created_at: "2026-06-03T12:00:02.000Z",
            },
          ],
        }, { status: 200 }));
      }
      return Promise.resolve(jsonResponse({ items: [] }, { status: 200 }));
    }));
    ({ AdminPage } = await import("./AdminPage"));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("pretty-prints valid JSON payloads and falls back for malformed or empty payloads", async () => {
    render(<AdminPage />);

    expect(await screen.findByText("audit-valid")).not.toBeNull();

    expect(screen.getByText((_, element) => element?.tagName.toLowerCase() === "pre" && element.textContent?.trim() === '{\n  "reason": "spam",\n  "count": 2\n}')).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName.toLowerCase() === "pre" && element.textContent?.trim() === "{invalid json")).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName.toLowerCase() === "pre" && element.textContent?.trim() === "n/a")).not.toBeNull();
  });
});
