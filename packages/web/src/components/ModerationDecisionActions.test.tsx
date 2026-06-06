// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModerationDecisionActions } from "./ModerationDecisionActions";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      switch (key) {
        case "moderateEvent":
          return "Moderate event";
        case "moderateEventTitle":
          return `Moderate event: ${options?.title ?? ""}`;
        case "moderationDecisionDescription":
          return "This decision changes event visibility. It does not edit the moderation note itself.";
        case "moderationRemovalReason":
          return "Removal reason";
        case "moderationKeepReason":
          return "Keep reason";
        case "moderationRemovalReasonPlaceholder":
          return "Explain why this event should be removed...";
        case "moderationKeepReasonPlaceholder":
          return "Explain why this event should remain visible...";
        case "moderationRemoveEvent":
          return "Remove event";
        case "moderationKeepEvent":
          return "Keep event";
        case "moderationDecisionAriaLabel":
          return "Moderation decision";
        case "moderationReasonRequired":
          return "Reason is required for moderation actions";
        case "moderationRequestFailed":
          return "Failed to moderate event";
        case "common:saving":
          return "Saving...";
        case "common:cancel":
          return "Cancel";
        case "common:close":
          return "Close";
        default:
          return key;
      }
    },
  }),
}));

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
        cache: "no-store",
        body: JSON.stringify({ state: "hidden", reason: "spam" }),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-CSRF-Token": "test-csrf-token",
        }),
      })
    );
  });

  it("closes and resets the modal after a successful moderation request", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));

    render(<ModerationDecisionActions eventId="event-1" eventTitle="Flagged Event" />);

    fireEvent.click(screen.getByRole("button", { name: "Moderate event" }));
    fireEvent.change(screen.getByLabelText("Removal reason"), { target: { value: "spam" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep event" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Keep event" })[1]);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Moderate event" }));

    const decisionGroup = screen.getByRole("group", { name: "Moderation decision" });

    expect((screen.getByLabelText("Removal reason") as HTMLTextAreaElement).value).toBe("");
    expect(within(decisionGroup).getByRole("button", { name: "Remove event" }).className).toContain("btn-danger");
    expect(within(decisionGroup).getByRole("button", { name: "Keep event" }).className).toContain("btn-ghost");
  });
});
