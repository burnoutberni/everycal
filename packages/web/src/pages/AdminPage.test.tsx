// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  authStatus: "anonymous" as "unknown" | "authenticated" | "anonymous",
  user: null as { isAdmin?: boolean } | null,
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/admin", mocks.navigate],
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: mocks.user,
    authStatus: mocks.authStatus,
  }),
}));

let AdminPage: (typeof import("./AdminPage"))["AdminPage"];

describe("AdminPage access redirects", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
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
    mocks.user = null;

    render(<AdminPage />);

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith("/login?next=%2Fadmin&notice=admin-required");
    });
  });

  it("redirects authenticated non-admin users to settings notice", async () => {
    mocks.authStatus = "authenticated";
    mocks.user = { isAdmin: false };

    render(<AdminPage />);

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith("/settings?notice=admin-required");
    });
  });
});
