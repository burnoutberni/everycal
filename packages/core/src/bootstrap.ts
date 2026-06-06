export type AppLocale = "en" | "de";

export type BootstrapViewer = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl?: string | null;
  themePreference?: "system" | "light" | "dark";
  notificationPrefs?: { onboardingCompleted?: boolean };
};

export type AppBootstrap = {
  locale: AppLocale;
  viewer: BootstrapViewer | null;
  isAuthenticated: boolean;
};

export type BootstrapUser = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl?: string | null;
  themePreference?: "system" | "light" | "dark";
  notificationPrefs: {
    reminderEnabled: boolean;
    reminderHoursBefore: number;
    eventUpdatedEnabled: boolean;
    eventCancelledEnabled: boolean;
    onboardingCompleted: boolean;
  };
};

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return value === "en" || value === "de";
}

function isBootstrapViewer(value: unknown): value is BootstrapViewer {
  if (!value || typeof value !== "object") return false;
  const viewer = value as Partial<BootstrapViewer>;
  if (typeof viewer.id !== "string") return false;
  if (typeof viewer.username !== "string") return false;
  if (viewer.displayName !== null && typeof viewer.displayName !== "string") return false;
  if (viewer.avatarUrl !== undefined && viewer.avatarUrl !== null && typeof viewer.avatarUrl !== "string") return false;
  if (
    viewer.themePreference !== undefined
    && viewer.themePreference !== "system"
    && viewer.themePreference !== "light"
    && viewer.themePreference !== "dark"
  ) {
    return false;
  }
  if (
    viewer.notificationPrefs !== undefined &&
    (typeof viewer.notificationPrefs !== "object" || viewer.notificationPrefs === null)
  ) {
    return false;
  }
  if (
    viewer.notificationPrefs?.onboardingCompleted !== undefined &&
    typeof viewer.notificationPrefs.onboardingCompleted !== "boolean"
  ) {
    return false;
  }
  return true;
}

export function isAppBootstrap(value: unknown): value is AppBootstrap {
  if (!value || typeof value !== "object") return false;
  const bootstrap = value as Partial<AppBootstrap>;
  if (!isAppLocale(bootstrap.locale)) return false;
  if (typeof bootstrap.isAuthenticated !== "boolean") return false;
  if (bootstrap.viewer !== null && bootstrap.viewer !== undefined && !isBootstrapViewer(bootstrap.viewer)) return false;
  if (bootstrap.isAuthenticated !== (bootstrap.viewer !== null && bootstrap.viewer !== undefined)) return false;
  return true;
}

export function bootstrapViewerToUser(viewer: BootstrapViewer | null | undefined): BootstrapUser | null | undefined {
  if (viewer === undefined) return undefined;
  if (viewer === null) return null;
  return {
    id: viewer.id,
    username: viewer.username,
    displayName: viewer.displayName,
    ...(viewer.avatarUrl !== undefined ? { avatarUrl: viewer.avatarUrl } : {}),
    ...(viewer.themePreference !== undefined ? { themePreference: viewer.themePreference } : {}),
    notificationPrefs: {
      reminderEnabled: true,
      reminderHoursBefore: 24,
      eventUpdatedEnabled: true,
      eventCancelledEnabled: true,
      onboardingCompleted: viewer.notificationPrefs?.onboardingCompleted ?? false,
    },
  };
}
