// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { AuthProvider } from "./useAuth";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  oidcLogout: vi.fn(),
  me: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  auth: {
    logout: mocks.logout,
    oidcLogout: mocks.oidcLogout,
    me: mocks.me,
  },
  onUnauthorized: vi.fn(() => () => {}),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../hooks/additionalIdentitiesCache", () => ({
  invalidateAdditionalIdentitiesCache: vi.fn(),
}));

vi.mock("../i18n", () => ({
  syncLanguageFromUser: vi.fn(),
}));

vi.mock("@everycal/core", () => ({
  bootstrapViewerToUser: vi.fn().mockReturnValue(null),
}));

import { useAuth } from "./useAuth";
import { ApiError } from "../lib/api";

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider initialUser={null}>{children}</AuthProvider>;
}

describe("useAuth logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.me.mockResolvedValue(null);
    Object.defineProperty(window, "location", {
      value: { assign: vi.fn(), href: "http://localhost:3000/" },
      writable: true,
    });
  });

  it("redirects to logoutUrl when logout succeeds with an OIDC URL", async () => {
    mocks.logout.mockResolvedValue({ ok: true, logoutUrl: "https://idp.example.test/logout" });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.logout();
    });

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.oidcLogout).not.toHaveBeenCalled();
    expect(window.location.assign).toHaveBeenCalledWith("https://idp.example.test/logout");
  });

  it("does not redirect when logoutUrl is null", async () => {
    mocks.logout.mockResolvedValue({ ok: true, logoutUrl: null });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.logout();
    });

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.oidcLogout).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("falls back to oidcLogout on 401 and redirects to its logoutUrl", async () => {
    mocks.logout.mockRejectedValue(new ApiError(401, "Unauthorized"));
    mocks.oidcLogout.mockResolvedValue({ ok: true, logoutUrl: "https://idp.example.test/oidc/logout" });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.logout();
    });

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.oidcLogout).toHaveBeenCalledOnce();
    expect(window.location.assign).toHaveBeenCalledWith("https://idp.example.test/oidc/logout");
  });

  it("does not redirect when oidcLogout fallback returns null logoutUrl", async () => {
    mocks.logout.mockRejectedValue(new ApiError(401, "Unauthorized"));
    mocks.oidcLogout.mockResolvedValue({ ok: true, logoutUrl: null });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.logout();
    });

    expect(mocks.oidcLogout).toHaveBeenCalledOnce();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("does not call oidcLogout for non-401 errors", async () => {
    mocks.logout.mockRejectedValue(new ApiError(500, "Server Error"));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.logout();
    });

    expect(mocks.oidcLogout).not.toHaveBeenCalled();
  });

  it("does not call oidcLogout for non-ApiError exceptions", async () => {
    mocks.logout.mockRejectedValue(new Error("network failure"));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.logout();
    });

    expect(mocks.oidcLogout).not.toHaveBeenCalled();
  });
});
