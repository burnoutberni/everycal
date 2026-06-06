// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  authStatus: "anonymous" as "unknown" | "authenticated" | "anonymous",
  loading: false,
  user: null as { id?: string; isAdmin?: boolean } | null,
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

    const banner = await screen.findByRole("alert");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("common.forbidden (403)");
    expect(screen.getByRole("heading", { name: "Admin Console" })).not.toBeNull();
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

    const banner = await screen.findByRole("alert");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("Request failed (401)");
    expect(screen.getByRole("heading", { name: "Admin Console" })).not.toBeNull();
  });

  it("dismisses the error banner while keeping the admin console visible", async () => {
    render(<AdminPage />);

    const banner = await screen.findByRole("alert");
    expect(banner).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Admin Console" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "Admin Console" })).not.toBeNull();
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

describe("AdminPage job run failure rendering", () => {
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
      if (url.includes("/api/v1/admin/jobs/runs")) {
        return Promise.resolve(jsonResponse({
          items: [
            {
              id: "job-failed",
              job_type: "scraper",
              status: "failed",
              result_json: JSON.stringify({
                error: "scraper job exited with code 1",
                stderr: "Missing scraper API key(s) for: flex_at",
              }),
              created_at: "2026-06-06 12:00:00",
              started_at: "2026-06-06 12:00:01",
              finished_at: "2026-06-06 12:00:02",
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

  it("shows failed job summaries and full stored result payloads", async () => {
    render(<AdminPage />);

    expect(await screen.findByText("job-failed")).not.toBeNull();
    expect(screen.getByText("scraper job exited with code 1")).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName.toLowerCase() === "pre" && element.textContent?.includes('"stderr": "Missing scraper API key(s) for: flex_at"'))).not.toBeNull();
  });
});

describe("AdminPage proactive federation suppression", () => {
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
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/api/v1/admin/federation/block") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true, blockId: "block-1" }, { status: 200 }));
      }
      return Promise.resolve(jsonResponse({ items: [] }, { status: 200 }));
    }));
    ({ AdminPage } = await import("./AdminPage"));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("requires a reason for proactive domain blocks", async () => {
    render(<AdminPage />);

    await screen.findByText("Admin Console");

    const reasonInput = screen.getByLabelText("Reason for block") as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Suppression target"), { target: { value: "example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply Suppression" }));

    expect(reasonInput.required).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes("/api/v1/admin/federation/block") && init?.method === "POST";
    })).toBe(false);
  });

  it("submits proactive domain blocks with a reason", async () => {
    render(<AdminPage />);

    await screen.findByText("Admin Console");

    fireEvent.change(screen.getByLabelText("Suppression target"), { target: { value: "example.org" } });
    fireEvent.change(screen.getByLabelText("Reason for block"), { target: { value: "spam network" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply Suppression" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/v1/admin/federation/block",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({ blockType: "domain", domain: "example.org", reason: "spam network" }),
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });
  });
});

describe("AdminPage account disable guards", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authStatus = "authenticated";
    mocks.loading = false;
    mocks.user = { id: "a1", isAdmin: true };
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
      if (url.includes("/api/v1/admin/accounts?")) {
        return Promise.resolve(jsonResponse({
          items: [
            { id: "a1", username: "admin", is_admin: 1, is_disabled: 0 },
            { id: "u1", username: "user", is_admin: 0, is_disabled: 0 },
          ],
          enabledAdminCount: 1,
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

  it("disables the current admin disable action and shows the reason", async () => {
    render(<AdminPage />);

    const ownGuard = await screen.findByText("You cannot disable your own admin account.");
    const ownRow = ownGuard.closest("li");
    expect(ownRow).not.toBeNull();
    expect((within(ownRow!).getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(true);

    const otherUser = screen.getByText("@user");
    const otherRow = otherUser.closest("li");
    expect(otherRow).not.toBeNull();
    expect((within(otherRow!).getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables the last enabled admin action without blocking non-admin disables", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/api/v1/admin/accounts?")) {
        return Promise.resolve(jsonResponse({
          items: [
            { id: "u2", username: "solo-admin", is_admin: 1, is_disabled: 0 },
            { id: "u1", username: "user", is_admin: 0, is_disabled: 0 },
          ],
          enabledAdminCount: 1,
        }, { status: 200 }));
      }
      return Promise.resolve(jsonResponse({ items: [] }, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    ({ AdminPage } = await import("./AdminPage"));

    render(<AdminPage />);

    const lastAdminGuard = await screen.findByText("You cannot disable the last enabled admin account.");
    const adminRow = lastAdminGuard.closest("li");
    expect(adminRow).not.toBeNull();
    expect((within(adminRow!).getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(true);

    const userRow = screen.getByText("@user").closest("li");
    expect(userRow).not.toBeNull();
    const userDisableButton = within(userRow!).getByRole("button", { name: "Disable" });
    expect((userDisableButton as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(userDisableButton);
    expect(screen.getByRole("heading", { name: "Disable @user" })).not.toBeNull();
  });
});
