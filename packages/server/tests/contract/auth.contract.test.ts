import { beforeEach, describe, expect, it } from "vitest";
import { createContractTestApp } from "./test-app.js";
import {
  expectAuthFailure,
  expectBoolean,
  expectErrorResponse,
  expectJsonStatus,
  expectNullableType,
  expectObjectKeys,
  expectType,
} from "./assertions.js";
import { sanitizeForContractSnapshot } from "./sanitize.js";

describe("auth route contract", () => {
  beforeEach(() => {
    process.env.OPEN_REGISTRATIONS = "true";
  });

  it("POST /register succeeds for valid registration", async () => {
    const { app } = createContractTestApp();
    const res = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "contract_auth_register_ok",
        email: "contract_auth_register_ok@example.com",
        password: "long-enough-password",
        city: "Vienna",
        cityLat: 48.2,
        cityLng: 16.37,
      }),
    });

    const body = await expectJsonStatus(res, 201);
    expectObjectKeys(body, ["requiresVerification", "email"]);
    expect(sanitizeForContractSnapshot(body)).toMatchInlineSnapshot(`
      {
        "email": "contract_auth_register_ok@example.com",
        "requiresVerification": true,
      }
    `);
  });

  it("POST /register rejects isBot mutation attempt", async () => {
    const { app } = createContractTestApp();
    const res = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "contract_bot", isBot: true }),
    });

    await expectErrorResponse(res, 400, { errorEquals: "common.requestFailed" });
  });

  it("POST /login returns 400 for malformed JSON", async () => {
    const { app, seedUser } = createContractTestApp();
    seedUser({ username: "contract_login_user", password: "pw" });
    const res = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    await expectErrorResponse(res, 400);
  });

  it("GET /me requires auth", async () => {
    const { app } = createContractTestApp();
    const res = await app.request("http://localhost/api/v1/auth/me");
    await expectAuthFailure(res);
  });

  it("GET /me returns stable schema invariants when authenticated", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ username: "contract_me_user" });
    const authApp = fixture.asUser(user);
    const res = await authApp.request("http://localhost/api/v1/auth/me");

    const body = await expectJsonStatus(res, 200);
    expectObjectKeys(body, [
      "id",
      "username",
      "displayName",
      "emailVerified",
      "notificationPrefs",
      "isBot",
      "discoverable",
      "timezone",
      "dateTimeLocale",
      "themePreference",
      "followingCount",
      "followersCount",
    ]);
    expectType(body.id, "string", "id");
    expectType(body.username, "string", "username");
    expectNullableType(body.displayName, "string", "displayName");
    expectNullableType(body.bio, "string", "bio");
    expectNullableType(body.avatarUrl, "string", "avatarUrl");
    expectNullableType(body.website, "string", "website");
    expectNullableType(body.city, "string", "city");
    expectNullableType(body.cityLat, "number", "cityLat");
    expectNullableType(body.cityLng, "number", "cityLng");
    expectNullableType(body.email, "string", "email");
    expectType(body.createdAt, "string", "createdAt");

    expectBoolean(body.isBot, "isBot");
    expectBoolean(body.discoverable, "discoverable");
    expectBoolean(body.emailVerified, "emailVerified");
    expectType(body.followingCount, "number", "followingCount");
    expectType(body.followersCount, "number", "followersCount");

    expectType(body.timezone, "string", "timezone");
    expect((body.timezone as string).length).toBeGreaterThan(0);
    expectType(body.dateTimeLocale, "string", "dateTimeLocale");
    expect((body.dateTimeLocale as string).length).toBeGreaterThan(0);
    expectType(body.themePreference, "string", "themePreference");
    expect((body.themePreference as string).length).toBeGreaterThan(0);

    const prefs = body.notificationPrefs as Record<string, unknown>;
    expectObjectKeys(prefs, [
      "reminderEnabled",
      "reminderHoursBefore",
      "eventUpdatedEnabled",
      "eventCancelledEnabled",
      "onboardingCompleted",
    ]);
    expectBoolean(prefs.reminderEnabled, "notificationPrefs.reminderEnabled");
    expectType(prefs.reminderHoursBefore, "number", "notificationPrefs.reminderHoursBefore");
    expectBoolean(prefs.eventUpdatedEnabled, "notificationPrefs.eventUpdatedEnabled");
    expectBoolean(prefs.eventCancelledEnabled, "notificationPrefs.eventCancelledEnabled");
    expectBoolean(prefs.onboardingCompleted, "notificationPrefs.onboardingCompleted");
  });

  it("PATCH /me rejects non-string city values", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_city_bad", username: "contract_city_bad" });
    const authApp = fixture.asUser(user);

    const res = await authApp.request("http://localhost/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: {} }),
    });
    await expectErrorResponse(res, 400);
  });

  it("PATCH /me rejects numeric city value", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_city_num", username: "contract_city_num" });
    const authApp = fixture.asUser(user);

    const res = await authApp.request("http://localhost/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: 123 }),
    });
    await expectErrorResponse(res, 400);
  });

  it("PATCH /me accepts null city to clear location", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_city_null", username: "contract_city_null" });
    fixture.db.prepare("UPDATE accounts SET city = 'Vienna', city_lat = 48.2, city_lng = 16.37 WHERE id = ?").run("u_city_null");
    const authApp = fixture.asUser(user);

    const res = await authApp.request("http://localhost/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: null, cityLat: null, cityLng: null }),
    });
    await expectJsonStatus(res, 200);

    const row = fixture.db.prepare("SELECT city, city_lat, city_lng FROM accounts WHERE id = ?").get("u_city_null") as {
      city: string | null;
      city_lat: number | null;
      city_lng: number | null;
    };
    expect(row.city).toBeNull();
    expect(row.city_lat).toBeNull();
    expect(row.city_lng).toBeNull();
  });

  it("PATCH /me updates profile but does not mutate is_bot", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_patch", username: "contract_patch" });
    const authApp = fixture.asUser(user);

    const res = await authApp.request("http://localhost/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Updated Contract", isBot: true }),
    });
    await expectJsonStatus(res, 200);

    const row = fixture.db.prepare("SELECT is_bot, display_name FROM accounts WHERE id = ?").get("u_patch") as {
      is_bot: number;
      display_name: string;
    };
    expect(row.display_name).toBe("Updated Contract");
    expect(row.is_bot).toBe(0);
  });
});
