// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  resolve: vi.fn(),
  search: "?uri=https%3A%2F%2Fremote.example%2Fevents%2F99",
}));

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: any }) => <a href={href}>{children}</a>,
  useLocation: () => ["/r/event", mocks.navigate],
  useSearch: () => mocks.search,
}));

vi.mock("../lib/api", () => ({
  events: {
    resolve: mocks.resolve,
  },
}));

import { EventResolvePage } from "./EventResolvePage";

describe("EventResolvePage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search = "?uri=https%3A%2F%2Fremote.example%2Fevents%2F99";
  });

  it("resolves uri and redirects to canonical path", async () => {
    mocks.resolve.mockResolvedValue({ path: "/@alice@remote.example/my-event", event: null });
    render(<EventResolvePage />);

    await waitFor(() => {
      expect(mocks.resolve).toHaveBeenCalledWith("https://remote.example/events/99");
      expect(mocks.navigate).toHaveBeenCalledWith("/@alice@remote.example/my-event", { replace: true });
    });
  });

  it("shows error when uri query param is missing", async () => {
    mocks.search = "";
    render(<EventResolvePage />);

    expect(await screen.findByText("Could not open event")).toBeTruthy();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("shows API failure message", async () => {
    mocks.resolve.mockRejectedValue(new Error("not found"));
    render(<EventResolvePage />);

    expect(await screen.findByText("not found")).toBeTruthy();
  });

  it("clears stale error when uri becomes valid", async () => {
    mocks.search = "";
    mocks.resolve.mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(<EventResolvePage />);

    expect(await screen.findByText("Missing event URI.")).toBeTruthy();

    mocks.search = "?uri=https%3A%2F%2Fremote.example%2Fevents%2F123";
    rerender(<EventResolvePage />);

    await waitFor(() => {
      expect(screen.getByText("Opening event…")).toBeTruthy();
      expect(screen.queryByText("Missing event URI.")).toBeNull();
      expect(mocks.resolve).toHaveBeenCalledWith("https://remote.example/events/123");
    });
  });
});
