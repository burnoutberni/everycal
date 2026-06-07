// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  login: vi.fn(),
  oidcProviders: vi.fn(),
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
  },
}));

let LoginPage: (typeof import("./LoginPage"))["LoginPage"];

describe("LoginPage", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/login");
    mocks.oidcProviders.mockResolvedValue({
      oidcEnabled: true,
      providers: [{ id: "oidc-1", label: "Acme SSO" }],
      localPasswordAuthEnabled: false,
      localRegistrationEnabled: false,
    });
    ({ LoginPage } = await import("./LoginPage"));
  });

  afterEach(() => {
    cleanup();
  });

  it("shows oidcError even when local auth is disabled", async () => {
    window.history.replaceState({}, "", "/login?oidcError=SSO%20failed");

    render(<LoginPage />);

    expect(await screen.findByText("SSO failed")).toBeTruthy();
    expect(await screen.findByText("Local username/password sign-in is disabled for this instance.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByLabelText("username")).toBeNull();
    });
  });
});
