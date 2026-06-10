import { type Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createContractTestApp } from "./test-app.js";
import { createApiKey } from "../../src/middleware/auth.js";

type ContractTestApp = ReturnType<typeof createContractTestApp>;
type SeededUser = ReturnType<ContractTestApp["seedUser"]>;

type Probe = {
  method: string;
  path: string;
  wrongMethod: string;
  label: string;
  allowedWrongStatuses?: number[];
  resolvePath?: (fixture: ContractTestApp, user: SeededUser) => string;
};

async function expectRouteWired(app: Hono, probe: Probe): Promise<void> {
  const url = `http://localhost${probe.path}`;

  const init = probe.method === "POST" || probe.method === "PATCH" || probe.method === "PUT"
    ? { method: probe.method, headers: { "content-type": "application/json" }, body: "{}" }
    : { method: probe.method };
  const expectedMethodRes = await app.request(url, init);
  expect(
    expectedMethodRes.status,
    `${probe.label}: expected ${probe.method} ${probe.path} to be a registered route (should not be 404)`,
  ).not.toBe(404);

  const wrongInit = probe.wrongMethod === "POST" || probe.wrongMethod === "PATCH" || probe.wrongMethod === "PUT"
    ? { method: probe.wrongMethod, headers: { "content-type": "application/json" }, body: "{}" }
    : { method: probe.wrongMethod };
  const wrongMethodRes = await app.request(url, wrongInit);
  const expectedWrongStatuses = probe.allowedWrongStatuses ?? [404, 405];
  expect(
    expectedWrongStatuses,
    `${probe.label}: expected ${probe.wrongMethod} ${probe.path} to fail as wrong method`,
  ).toContain(wrongMethodRes.status);
}

describe("route wiring contract", () => {
  it("all mounted auth routes are wired with expected methods", async () => {
    process.env.OPEN_REGISTRATIONS = "true";
    const probes: Probe[] = [
      { method: "POST", path: "/api/v1/auth/register", wrongMethod: "GET", label: "auth register" },
      { method: "POST", path: "/api/v1/auth/login", wrongMethod: "GET", label: "auth login" },
      { method: "POST", path: "/api/v1/auth/logout", wrongMethod: "GET", label: "auth logout" },
      { method: "GET", path: "/api/v1/auth/oidc/providers", wrongMethod: "POST", label: "auth oidc providers" },
      { method: "POST", path: "/api/v1/auth/oidc/start", wrongMethod: "GET", label: "auth oidc start" },
      { method: "GET", path: "/api/v1/auth/oidc/callback", wrongMethod: "POST", label: "auth oidc callback" },
      { method: "POST", path: "/api/v1/auth/oidc/logout", wrongMethod: "GET", label: "auth oidc logout" },
      { method: "GET", path: "/api/v1/auth/me", wrongMethod: "POST", label: "auth me read" },
      {
        method: "PATCH",
        path: "/api/v1/auth/me",
        wrongMethod: "PUT",
        label: "auth me update",
      },
      { method: "DELETE", path: "/api/v1/auth/me", wrongMethod: "PUT", label: "auth me delete" },
      {
        method: "PATCH",
        path: "/api/v1/auth/notification-prefs",
        wrongMethod: "POST",
        label: "auth notification prefs update",
      },
      { method: "GET", path: "/api/v1/auth/verify-email", wrongMethod: "POST", label: "auth verify email" },
      {
        method: "POST",
        path: "/api/v1/auth/request-email-change",
        wrongMethod: "GET",
        label: "auth request email change",
      },
      {
        method: "POST",
        path: "/api/v1/auth/change-password",
        wrongMethod: "GET",
        label: "auth change password",
      },
      {
        method: "POST",
        path: "/api/v1/auth/forgot-password",
        wrongMethod: "GET",
        label: "auth forgot password",
      },
      {
        method: "POST",
        path: "/api/v1/auth/reset-password",
        wrongMethod: "GET",
        label: "auth reset password",
      },
      { method: "GET", path: "/api/v1/auth/api-keys", wrongMethod: "PATCH", label: "auth api keys list" },
      { method: "POST", path: "/api/v1/auth/api-keys", wrongMethod: "PATCH", label: "auth api keys create" },
      {
        method: "DELETE",
        path: "/api/v1/auth/api-keys",
        wrongMethod: "PATCH",
        label: "auth api keys delete",
        resolvePath: (fixture, user) => `${"/api/v1/auth/api-keys"}/${createApiKey(fixture.db, user.id, "Contract key").id}`,
      },
    ];

    for (const probe of probes) {
      const fixture = createContractTestApp();
      const user = fixture.seedUser();
      const authApp = fixture.asUser(user);
      await expectRouteWired(authApp, { ...probe, path: probe.resolvePath?.(fixture, user) ?? probe.path });
    }
  });

  it("events routes are mounted with expected methods", async () => {
    const probes: Probe[] = [
      { method: "GET", path: "/api/v1/events", wrongMethod: "PATCH", label: "events list" },
      { method: "GET", path: "/api/v1/events/timeline", wrongMethod: "PATCH", label: "events timeline" },
      { method: "POST", path: "/api/v1/events", wrongMethod: "PATCH", label: "events create" },
      { method: "POST", path: "/api/v1/events/rsvp", wrongMethod: "GET", label: "events rsvp" },
      { method: "DELETE", path: "/api/v1/events/e_contract_wire", wrongMethod: "PATCH", label: "events delete" },
    ];

    const fixture = createContractTestApp();

    for (const probe of probes) {
      await expectRouteWired(fixture.app, probe);
    }
  });
});
