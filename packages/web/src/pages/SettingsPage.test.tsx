// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  setLocation: vi.fn(),
  changeLanguage: vi.fn(),
  refreshUser: vi.fn(async () => {}),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: any }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useLocation: () => ["/settings", mocks.setLocation],
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1", username: "alice", email: "alice@example.com" },
    refreshUser: mocks.refreshUser,
  }),
}));

vi.mock("../i18n", () => ({
  changeLanguage: mocks.changeLanguage,
}));

vi.mock("../components/CitySearch", () => ({
  CitySearch: ({ value, onChange }: { value: { city: string; lat: number; lng: number } | null; onChange: (value: { city: string; lat: number; lng: number } | null) => void }) => (
    <div>
      <input aria-label="city-search" value={value?.city || ""} readOnly />
      <button type="button" onClick={() => onChange({ city: "Vienna", lat: 48.2, lng: 16.37 })}>set-city</button>
      <button type="button" onClick={() => onChange(null)}>clear-city</button>
    </div>
  ),
}));

vi.mock("../components/ProfileHeader", () => ({
  ProfileHeader: ({ inlineDraft, onInlineDraftChange, onInlineAvatarUpload, avatarUploading, inlineError }: any) => (
    <div>
      <input
        aria-label="wizard-website"
        value={inlineDraft?.website || ""}
        onChange={(e) => onInlineDraftChange?.({ ...inlineDraft, website: e.target.value })}
      />
      <button type="button" onClick={() => onInlineAvatarUpload?.(new File([new Uint8Array(32)], "avatar.png", { type: "image/png" }))}>
        upload-avatar
      </button>
      {avatarUploading && <p>avatar-uploading</p>}
      {inlineError && <p>{inlineError}</p>}
    </div>
  ),
}));

vi.mock("../lib/api", () => ({
  auth: {
    me: vi.fn(),
    listApiKeys: vi.fn(),
    updateProfile: vi.fn(),
    updateNotificationPrefs: vi.fn(),
    requestEmailChange: vi.fn(),
    changePassword: vi.fn(),
    deleteApiKey: vi.fn(),
    createApiKey: vi.fn(),
    deleteAccount: vi.fn(),
  },
  identities: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    listMembers: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
  },
  uploads: {
    upload: vi.fn(),
  },
  users: {
    list: vi.fn(),
  },
}));

import { SettingsPage } from "./SettingsPage";
import { auth as authApi, identities as identitiesApi, uploads } from "../lib/api";
import { ThemeProvider } from "../hooks/useTheme";
import { THEME_STORAGE_KEY } from "../lib/theme";

function renderSettingsPage() {
  return render(
    <ThemeProvider>
      <SettingsPage />
    </ThemeProvider>
  );
}

describe("SettingsPage identity flows", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.mocked(authApi.me).mockResolvedValue({
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      discoverable: true,
      preferredLanguage: "en",
      city: "Vienna",
      cityLat: 48.2,
      cityLng: 16.37,
      notificationPrefs: {
        reminderEnabled: true,
        reminderHoursBefore: 24,
        eventUpdatedEnabled: true,
        eventCancelledEnabled: true,
      },
    } as any);
    vi.mocked(authApi.listApiKeys).mockResolvedValue({ keys: [] });
    vi.mocked(identitiesApi.list).mockResolvedValue({ identities: [] });
    vi.mocked(uploads.upload).mockResolvedValue({ url: "https://example.com/avatar.png" } as any);
  });

  it("blocks step progress on invalid handle and invalid website", async () => {
    renderSettingsPage();

    fireEvent.click(await screen.findByRole("button", { name: "createPublishingIdentity" }));

    const next = await screen.findByRole("button", { name: "createIdentityNextStep" });
    fireEvent.change(screen.getByPlaceholderText("usernamePlaceholder"), { target: { value: "a" } });
    fireEvent.click(next);

    expect(await screen.findByText("invalidIdentityHandle")).toBeTruthy();
    expect(screen.queryByText("identityPreviewHelp")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("usernamePlaceholder"), { target: { value: "team_one" } });
    fireEvent.click(screen.getByRole("button", { name: "createIdentityNextStep" }));
    expect(await screen.findByText("identityPreviewHelp")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("wizard-website"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "createIdentityNextStep" }));

    expect(await screen.findByText("invalidWebsiteUrl")).toBeTruthy();
    expect(screen.queryByText("defaultEventVisibility")).toBeNull();
  });

  it("disables wizard next while avatar upload is in progress", async () => {
    let resolveUpload: ((value: { url: string }) => void) | undefined;
    vi.mocked(uploads.upload).mockImplementation(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }) as Promise<any>);

    renderSettingsPage();
    fireEvent.click(await screen.findByRole("button", { name: "createPublishingIdentity" }));

    fireEvent.change(screen.getByPlaceholderText("usernamePlaceholder"), { target: { value: "team_one" } });
    fireEvent.click(screen.getByRole("button", { name: "createIdentityNextStep" }));
    await screen.findByText("identityPreviewHelp");

    const next = screen.getByRole("button", { name: "createIdentityNextStep" });
    expect(next).toBeTruthy();
    expect((next as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "upload-avatar" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "createIdentityNextStep" }) as HTMLButtonElement).disabled).toBe(true);
    });

    if (!resolveUpload) throw new Error("Expected upload resolver to be set");
    resolveUpload({ url: "https://example.com/avatar.png" });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "createIdentityNextStep" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("creates identity and redirects to its profile", async () => {
    vi.mocked(identitiesApi.create).mockResolvedValue({
      identity: { username: "team_one" },
    } as any);

    renderSettingsPage();
    fireEvent.click(await screen.findByRole("button", { name: "createPublishingIdentity" }));

    fireEvent.change(screen.getByPlaceholderText("usernamePlaceholder"), { target: { value: "team_one" } });
    fireEvent.click(screen.getByRole("button", { name: "createIdentityNextStep" }));
    await screen.findByText("identityPreviewHelp");

    fireEvent.click(screen.getByRole("button", { name: "createIdentityNextStep" }));
    await screen.findByText("defaultEventVisibility");

    fireEvent.click(screen.getByRole("button", { name: "createAndEditIdentity" }));

    await waitFor(() => {
      expect(identitiesApi.create).toHaveBeenCalledTimes(1);
      expect(mocks.setLocation).toHaveBeenCalledWith("/@team_one");
    });
  });

  it("closes identity settings modal with Escape and restores trigger focus", async () => {
    vi.mocked(identitiesApi.list).mockResolvedValue({
      identities: [{
        id: "id-1",
        username: "team_one",
        role: "owner",
        displayName: "Team One",
        discoverable: true,
        defaultVisibility: "public",
        preferredLanguage: "en",
        city: "Vienna",
        cityLat: 48.2,
        cityLng: 16.37,
      }],
    } as any);

    renderSettingsPage();

    const settingsButton = await screen.findByRole("button", { name: "identitySettings" });
    settingsButton.focus();
    fireEvent.click(settingsButton);

    await screen.findByText("identitySettings: @team_one");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText("identitySettings: @team_one")).toBeNull();
      expect(document.activeElement).toBe(settingsButton);
    });
  });

  it("sends null city values when clearing identity city settings", async () => {
    vi.mocked(identitiesApi.list).mockResolvedValue({
      identities: [{
        id: "id-1",
        username: "team_one",
        role: "owner",
        displayName: "Team One",
        discoverable: true,
        defaultVisibility: "public",
        preferredLanguage: "en",
        city: "Vienna",
        cityLat: 48.2,
        cityLng: 16.37,
      }],
    } as any);
    vi.mocked(identitiesApi.update).mockResolvedValue({ identity: { username: "team_one" } } as any);

    renderSettingsPage();
    fireEvent.click(await screen.findByRole("button", { name: "identitySettings" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "clear-city" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "common:save" }));

    await waitFor(() => {
      expect(identitiesApi.update).toHaveBeenCalledWith("team_one", expect.objectContaining({
        city: null,
        cityLat: null,
        cityLng: null,
      }));
    });
  });

  it("renders theme preference as native radio inputs", async () => {
    renderSettingsPage();

    const systemOption = await screen.findByRole("radio", { name: "themeSystem" }) as HTMLInputElement;
    const darkOption = screen.getByRole("radio", { name: "themeDark" }) as HTMLInputElement;

    expect(systemOption.checked).toBe(true);
    expect(darkOption.checked).toBe(false);

    fireEvent.click(darkOption);

    expect(darkOption.checked).toBe(true);
    expect(systemOption.checked).toBe(false);
  });

  it("previews selected theme and persists it on calendar save", async () => {
    vi.mocked(authApi.updateProfile).mockResolvedValue({} as any);

    renderSettingsPage();

    const darkOption = await screen.findByRole("radio", { name: "themeDark" }) as HTMLInputElement;
    fireEvent.click(darkOption);

    expect(darkOption.checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    const calendarForm = darkOption.closest("form");
    if (!calendarForm) throw new Error("Expected calendar settings form");
    fireEvent.submit(calendarForm);

    await waitFor(() => {
      expect(authApi.updateProfile).toHaveBeenCalledWith(expect.objectContaining({
        themePreference: "dark",
      }));
    });
    await waitFor(() => {
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    });
  });

  it("rolls back theme selection when calendar save fails", async () => {
    vi.mocked(authApi.updateProfile).mockRejectedValue(new Error("theme-save-failed"));

    renderSettingsPage();

    const systemOption = await screen.findByRole("radio", { name: "themeSystem" }) as HTMLInputElement;
    const darkOption = screen.getByRole("radio", { name: "themeDark" }) as HTMLInputElement;

    fireEvent.click(darkOption);
    expect(darkOption.checked).toBe(true);

    const calendarForm = darkOption.closest("form");
    if (!calendarForm) throw new Error("Expected calendar settings form");
    fireEvent.submit(calendarForm);

    await waitFor(() => {
      expect(authApi.updateProfile).toHaveBeenCalledWith(expect.objectContaining({
        themePreference: "dark",
      }));
    });
    await waitFor(() => {
      expect(systemOption.checked).toBe(true);
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(await screen.findByText("theme-save-failed")).toBeTruthy();
  });
});
