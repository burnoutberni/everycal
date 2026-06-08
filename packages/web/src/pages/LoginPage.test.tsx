// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  login: vi.fn(),
  oidcProviders: vi.fn(),
  startOidc: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: any }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useLocation: () => ["/login", mocks.navigate],
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: null,
    login: mocks.login,
  }),
}));

vi.mock("../lib/api", () => ({
  auth: {
    oidcProviders: mocks.oidcProviders,
    startOidc: mocks.startOidc,
  },
}));

let LoginPage: (typeof import("./LoginPage"))["LoginPage"];

describe("LoginPage", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/login");
    mocks.login.mockResolvedValue({ notificationPrefs: { onboardingCompleted: true } });
    mocks.oidcProviders.mockResolvedValue({
      oidcEnabled: true,
      providers: [{ id: "oidc-1", label: "Acme SSO" }],
      localPasswordAuthEnabled: false,
      localRegistrationEnabled: false,
    });
    mocks.startOidc.mockResolvedValue({ authorizationUrl: "https://idp.example.test/authorize" });
    ({ LoginPage } = await import("./LoginPage"));
  });

  afterEach(() => {
    cleanup();
  });

  it("maps oidcError codes to translated messages even when local auth is disabled", async () => {
    window.history.replaceState({}, "", "/login?oidcError=oidc_verified_email_required");

    render(<LoginPage />);

    expect(await screen.findByText("oidcVerifiedEmailRequired")).toBeTruthy();
    expect(await screen.findByText("Local username/password sign-in is disabled for this instance.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByLabelText("username")).toBeNull();
    });
  });

  it("falls back to a generic translated message for unknown oidcError codes", async () => {
    window.history.replaceState({}, "", "/login?oidcError=connect%20ECONNREFUSED%20https%3A%2F%2Fidp.example.test%2Ftoken");

    render(<LoginPage />);

    expect(await screen.findByText("oidcLoginFailed")).toBeTruthy();
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
  });

  it("sanitizes unsafe double-slash redirects for local login", async () => {
    window.history.replaceState({}, "", "/login?next=%2F%2Fevil.example");
    mocks.oidcProviders.mockResolvedValue({
      oidcEnabled: false,
      providers: [],
      localPasswordAuthEnabled: true,
      localRegistrationEnabled: true,
    });

    render(<LoginPage />);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("username"), "alice");
    await user.type(screen.getByLabelText("password"), "secret");
    await user.click(screen.getByRole("button", { name: "logIn" }));

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith("/");
    });
  });

  it("passes a sanitized in-app redirect target to SSO", async () => {
    window.history.replaceState({}, "", "/login?redirectTo=%2Fsettings");
    mocks.startOidc.mockRejectedValue(new Error("SSO login failed"));

    render(<LoginPage />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign in with Acme SSO" }));

    await waitFor(() => {
      expect(mocks.startOidc).toHaveBeenCalledWith("/settings");
    });
  });
});
