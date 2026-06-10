import type { AuthProviderInfo } from "../lib/api";

export function makeAuthProviderInfo(overrides: Partial<AuthProviderInfo> = {}): AuthProviderInfo {
  return {
    oidcEnabled: true,
    configError: null,
    localPasswordAuthEnabled: true,
    localRegistrationEnabled: true,
    providers: [{ providerKey: "oidc", label: "Single Sign-On" }],
    ...overrides,
  };
}
