// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  refreshUser: vi.fn(async () => {}),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/onboarding", mocks.navigate],
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../components/CitySearch", () => ({
  CitySearch: ({ value, onChange }: { value: { city: string; lat: number; lng: number } | null; onChange: (value: { city: string; lat: number; lng: number } | null) => void }) => (
    <div>
      <input aria-label="city-search" value={value?.city || ""} readOnly />
      <button type="button" onClick={() => onChange({ city: "Berlin", lat: 52.52, lng: 13.405 })}>set-city</button>
    </div>
  ),
}));

vi.mock("../components/CalendarSubscribeButtons", () => ({
  CalendarSubscribeButtons: () => <div>calendar-buttons</div>,
}));

vi.mock("../components/icons", () => ({
  CalendarIcon: () => <span>calendar-icon</span>,
  CheckIcon: () => <span>check-icon</span>,
  LinkIcon: () => <span>link-icon</span>,
  MailIcon: () => <span>mail-icon</span>,
}));

vi.mock("../lib/api", () => ({
  auth: {
    updateProfile: vi.fn(),
    updateNotificationPrefs: vi.fn(),
  },
  feeds: {
    getCalendarUrl: vi.fn(async () => ({ url: "https://example.com/feed.ics" })),
  },
}));

import { useAuth } from "../hooks/useAuth";
import { auth as authApi } from "../lib/api";
import { OnboardingPage } from "./OnboardingPage";

const mockedUseAuth = vi.mocked(useAuth);

describe("OnboardingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("requires a location before finishing onboarding for users without one", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "u1", username: "jit", city: null, cityLat: null, cityLng: null },
      refreshUser: mocks.refreshUser,
    } as never);

    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "continue" }));

    expect(await screen.findByText("locationRequired")).toBeTruthy();
    expect(authApi.updateProfile).not.toHaveBeenCalled();
    expect(authApi.updateNotificationPrefs).not.toHaveBeenCalled();
  });

  it("saves location before completing onboarding when missing", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "u1", username: "jit", city: null, cityLat: null, cityLng: null },
      refreshUser: mocks.refreshUser,
    } as never);
    vi.mocked(authApi.updateProfile).mockResolvedValue({ ok: true });
    vi.mocked(authApi.updateNotificationPrefs).mockResolvedValue({ ok: true });

    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "set-city" }));
    fireEvent.click(screen.getByRole("button", { name: "continue" }));

    await waitFor(() => {
      expect(authApi.updateProfile).toHaveBeenCalledWith({ city: "Berlin", cityLat: 52.52, cityLng: 13.405 });
    });
    expect(authApi.updateNotificationPrefs).toHaveBeenCalledWith({
      reminderEnabled: true,
      reminderHoursBefore: 24,
      eventUpdatedEnabled: true,
      eventCancelledEnabled: true,
      onboardingCompleted: true,
    });
    expect(mocks.refreshUser).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith("/");
  });

  it("shows the location-specific error when onboarding completion is rejected for missing city", async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: "u1", username: "jit", city: null, cityLat: null, cityLng: null },
      refreshUser: mocks.refreshUser,
    } as never);
    vi.mocked(authApi.updateProfile).mockResolvedValue({ ok: true });
    vi.mocked(authApi.updateNotificationPrefs).mockRejectedValue(new Error("auth.city_required"));

    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "set-city" }));
    fireEvent.click(screen.getByRole("button", { name: "continue" }));

    expect(await screen.findByText("locationRequired")).toBeTruthy();
    expect(screen.queryByText("saveFailed")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
