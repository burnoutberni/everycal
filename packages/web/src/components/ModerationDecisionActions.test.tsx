// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModerationDecisionActions } from "./ModerationDecisionActions";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("ModerationDecisionActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    document.cookie = "everycal_csrf=test-csrf-token";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.cookie = "everycal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("shows shared admin error messages from the server", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "moderation.denied" }, { status: 403 }));

    render(<ModerationDecisionActions eventId="event-1" eventTitle="Flagged Event" />);

    fireEvent.click(screen.getByRole("button", { name: "Moderate event" }));
    fireEvent.change(screen.getByLabelText("Removal reason"), { target: { value: "spam" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove event" })[1]);

    expect((await screen.findByRole("alert")).textContent).toContain("moderation.denied (403)");
  });

  it("submits moderation requests with the shared admin fetch defaults", async () => {
    const onResolved = vi.fn();
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));

    render(<ModerationDecisionActions eventId="event/1" eventTitle="Flagged Event" onResolved={onResolved} />);

    fireEvent.click(screen.getByRole("button", { name: "Moderate event" }));
    fireEvent.change(screen.getByLabelText("Removal reason"), { target: { value: "spam" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove event" })[1]);

    await waitFor(() => {
      expect(onResolved).toHaveBeenCalledWith("hidden");
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/admin/events/event%2F1/moderate",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ state: "hidden", reason: "spam" }),
        headers: expect.any(Headers),
      })
    );

    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("test-csrf-token");
  });
});
