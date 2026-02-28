import { describe, expect, it } from "vitest";
import { bootstrapViewerToUser, isAppBootstrap, isAppLocale } from "./bootstrap.js";

describe("bootstrap contract", () => {
  it("validates supported locales", () => {
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("de")).toBe(true);
    expect(isAppLocale("fr")).toBe(false);
  });

  it("validates bootstrap payload", () => {
    expect(
      isAppBootstrap({
        locale: "de",
        isAuthenticated: true,
        viewer: { id: "1", username: "alice", displayName: "Alice" },
      })
    ).toBe(true);

    expect(
      isAppBootstrap({
        locale: "de",
        isAuthenticated: false,
        viewer: { id: "1", username: "alice", displayName: "Alice" },
      })
    ).toBe(false);
  });

  it("maps bootstrap viewer to user shape", () => {
    const mapped = bootstrapViewerToUser({
      id: "1",
      username: "alice",
      displayName: "Alice",
      avatarUrl: null,
      notificationPrefs: { onboardingCompleted: true },
    });

    expect(mapped).toEqual({
      id: "1",
      username: "alice",
      displayName: "Alice",
      avatarUrl: null,
      notificationPrefs: {
        reminderEnabled: true,
        reminderHoursBefore: 24,
        eventUpdatedEnabled: true,
        eventCancelledEnabled: true,
        onboardingCompleted: true,
      },
    });

    expect(bootstrapViewerToUser(undefined)).toBeUndefined();
    expect(bootstrapViewerToUser(null)).toBeNull();
  });
});
