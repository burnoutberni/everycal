import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openIdMocks = vi.hoisted(() => ({
  ClientSecretPost: vi.fn(() => ({ kind: "client_secret_post" })),
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  buildEndSessionUrl: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  discovery: vi.fn(),
  fetchUserInfo: vi.fn(),
}));

vi.mock("openid-client", () => openIdMocks);

import { getOidcAdapter, getOidcProviderConfig, mergeOidcClaims, resetOidcAdapterForTests } from "../src/lib/oidc.js";

const ORIGINAL_ENV = { ...process.env };

function configureOidc() {
  process.env.OIDC_ENABLED = "true";
  process.env.OIDC_ISSUER_URL = "https://idp.example.test/application/o/everycal/";
  process.env.OIDC_CLIENT_ID = "everycal";
  process.env.OIDC_CLIENT_SECRET = "secret";
  process.env.OIDC_REDIRECT_URI = "http://localhost/api/v1/auth/oidc/callback";
  process.env.BASE_URL = "http://localhost";
}

describe("OIDC library", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configureOidc();
    vi.clearAllMocks();
    resetOidcAdapterForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("merges UserInfo claims into callback claims while preserving verified iss/sub", async () => {
    openIdMocks.discovery.mockResolvedValue({
      serverMetadata: () => ({ userinfo_endpoint: "https://idp.example.test/application/o/everycal/userinfo" }),
    });
    openIdMocks.authorizationCodeGrant.mockResolvedValue({
      access_token: "access-token",
      claims: () => ({
        iss: process.env.OIDC_ISSUER_URL!,
        sub: "verified-subject",
        name: "Alice From ID Token",
      }),
    });
    openIdMocks.fetchUserInfo.mockResolvedValue({
      iss: "https://attacker.example.test/",
      sub: "tampered-subject",
      email: "alice@example.com",
      email_verified: true,
      preferred_username: "alice-sso",
    });

    const result = await getOidcAdapter().exchangeCallback(getOidcProviderConfig(), "http://localhost/api/v1/auth/oidc/callback?state=s&code=x", {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
    });

    expect(openIdMocks.fetchUserInfo).toHaveBeenCalledWith(expect.anything(), "access-token", "verified-subject");
    expect(result).toEqual({
      issuer: process.env.OIDC_ISSUER_URL!,
      subject: "verified-subject",
      claims: {
        iss: process.env.OIDC_ISSUER_URL!,
        sub: "verified-subject",
        name: "Alice From ID Token",
        email: "alice@example.com",
        email_verified: true,
        preferred_username: "alice-sso",
      },
    });
  });

  it("skips UserInfo when the provider does not advertise the endpoint", async () => {
    process.env.OIDC_CLIENT_ID = "everycal-without-userinfo";
    openIdMocks.discovery.mockResolvedValue({
      serverMetadata: () => ({}),
    });
    openIdMocks.authorizationCodeGrant.mockResolvedValue({
      access_token: "access-token",
      claims: () => ({ iss: process.env.OIDC_ISSUER_URL!, sub: "verified-subject" }),
    });

    const result = await getOidcAdapter().exchangeCallback(getOidcProviderConfig(), "http://localhost/api/v1/auth/oidc/callback?state=s&code=x", {
      state: "s",
      nonce: "n",
      codeVerifier: "v",
    });

    expect(openIdMocks.fetchUserInfo).not.toHaveBeenCalled();
    expect(result.claims).toEqual({ iss: process.env.OIDC_ISSUER_URL!, sub: "verified-subject" });
  });

  it("retries discovery after a transient failure", async () => {
    openIdMocks.discovery
      .mockRejectedValueOnce(new Error("temporary discovery failure"))
      .mockResolvedValueOnce({
        serverMetadata: () => ({}),
      });
    openIdMocks.calculatePKCECodeChallenge.mockResolvedValue("challenge");
    openIdMocks.buildAuthorizationUrl.mockReturnValue(new URL("https://idp.example.test/authorize"));

    await expect(getOidcAdapter().buildAuthorizationUrl(getOidcProviderConfig(), {
      state: "s1",
      nonce: "n1",
      codeVerifier: "v1",
    })).rejects.toThrow("temporary discovery failure");

    await expect(getOidcAdapter().buildAuthorizationUrl(getOidcProviderConfig(), {
      state: "s2",
      nonce: "n2",
      codeVerifier: "v2",
    })).resolves.toBe("https://idp.example.test/authorize");

    expect(openIdMocks.discovery).toHaveBeenCalledTimes(2);
  });

  it("mergeOidcClaims preserves iss/sub from the ID token", () => {
    expect(mergeOidcClaims(
      { iss: "https://issuer.example.test/", sub: "trusted-subject", name: "Alice" },
      { iss: "https://other.example.test/", sub: "other-subject", email: "alice@example.com", email_verified: true },
    )).toEqual({
      iss: "https://issuer.example.test/",
      sub: "trusted-subject",
      name: "Alice",
      email: "alice@example.com",
      email_verified: true,
    });
  });
});
