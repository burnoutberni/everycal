// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  refreshUser: vi.fn(async () => {}),
  verifyEmail: vi.fn(),
  search: "?token=token-default",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/verify-email", mocks.navigate],
  useSearch: () => mocks.search,
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    refreshUser: mocks.refreshUser,
  }),
}));

vi.mock("../lib/api", () => ({
  auth: {
    verifyEmail: mocks.verifyEmail,
  },
}));

import { VerifyEmailPage } from "./VerifyEmailPage";
import { auth as authApi } from "../lib/api";

describe("VerifyEmailPage", () => {
  const settleVerification = async () => {
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search = "?token=token-default";
  });

  it("shows an error when token is missing", async () => {
    mocks.search = "";

    render(<VerifyEmailPage />);

    expect(await screen.findByText("missingToken")).toBeTruthy();
    expect(authApi.verifyEmail).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent verification requests for the same token", async () => {
    mocks.search = "?token=token-dedupe";
    let resolveVerify: ((value: any) => void) | undefined;
    vi.mocked(authApi.verifyEmail).mockImplementation(() => new Promise((resolve) => {
      resolveVerify = resolve;
    }) as Promise<any>);

    render(
      <>
        <VerifyEmailPage />
        <VerifyEmailPage />
      </>
    );

    await waitFor(() => {
      expect(authApi.verifyEmail).toHaveBeenCalledTimes(1);
    });

    if (!resolveVerify) throw new Error("Expected verify resolver to be set");
    resolveVerify({ emailChanged: false });

    expect(await screen.findAllByText("emailVerified")).toHaveLength(2);
  });

  it("uses server-provided redirect destination", async () => {
    vi.useFakeTimers();
    mocks.search = "?token=token-email-change";
    vi.mocked(authApi.verifyEmail).mockResolvedValue({ emailChanged: false, redirectTo: "/settings" } as any);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    render(<VerifyEmailPage />);

    await settleVerification();
    expect(screen.getByText("emailVerified")).toBeTruthy();
    expect(mocks.refreshUser).toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
    expect(mocks.navigate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2499);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/settings");
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it("falls back to emailChanged redirect when server redirect is missing", async () => {
    vi.useFakeTimers();
    mocks.search = "?token=token-email-change-fallback";
    vi.mocked(authApi.verifyEmail).mockResolvedValue({ emailChanged: true } as any);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    render(<VerifyEmailPage />);

    await settleVerification();
    expect(screen.getByText("emailUpdated")).toBeTruthy();
    expect(mocks.refreshUser).toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
    expect(mocks.navigate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2499);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/settings");
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
});
