import { type Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createContractTestApp } from "./test-app.js";

type Probe = {
  method: string;
  path: string;
  wrongMethod: string;
  label: string;
  allowedWrongStatuses?: number[];
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
  it("auth routes are mounted with expected methods", async () => {
    process.env.OPEN_REGISTRATIONS = "true";
    const probes: Probe[] = [
      { method: "POST", path: "/api/v1/auth/register", wrongMethod: "GET", label: "auth register" },
      { method: "POST", path: "/api/v1/auth/login", wrongMethod: "GET", label: "auth login" },
      { method: "GET", path: "/api/v1/auth/oidc/providers", wrongMethod: "POST", label: "auth oidc providers" },
      { method: "POST", path: "/api/v1/auth/oidc/start", wrongMethod: "GET", label: "auth oidc start" },
      { method: "GET", path: "/api/v1/auth/oidc/callback", wrongMethod: "POST", label: "auth oidc callback" },
      { method: "GET", path: "/api/v1/auth/me", wrongMethod: "POST", label: "auth me read" },
      {
        method: "PATCH",
        path: "/api/v1/auth/me",
        wrongMethod: "PUT",
        label: "auth me update",
      },
    ];

    const fixture = createContractTestApp();
    const user = fixture.seedUser();
    const authApp = fixture.asUser(user);

    for (const probe of probes) {
      await expectRouteWired(authApp, probe);
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
