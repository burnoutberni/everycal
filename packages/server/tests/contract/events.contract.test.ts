import { describe, expect, it } from "vitest";
import { createContractTestApp } from "./test-app.js";
import { expectAuthFailure, expectErrorResponse, expectJsonStatus, expectObjectKeys } from "./assertions.js";
import { sanitizeForContractSnapshot } from "./sanitize.js";

function buildValidCreatePayload() {
  return {
    title: "Contract Event Create",
    startDate: "2026-07-20",
    eventTimezone: "UTC",
    allDay: true,
    visibility: "public",
    url: "https://example.com/events/contract",
  };
}

describe("events route contract", () => {
  it("GET /events returns shape with events array and cursor semantics", async () => {
    const fixture = createContractTestApp();
    const owner = fixture.seedUser({ id: "u_event_owner", username: "events_owner" });
    fixture.seedEvent({
      id: "e_contract_1",
      accountId: owner.id,
      slug: "e-contract-1",
      title: "Contract Event 1",
      startDate: "2026-01-01",
      startAtUtc: "2026-01-01T00:00:00.000Z",
    });

    const res = await fixture.app.request("http://localhost/api/v1/events?limit=2");
    const body = await expectJsonStatus(res, 200) as { events?: unknown[]; nextCursor?: unknown };

    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events?.length).toBeGreaterThan(0);
    expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
    const firstEvent = body.events?.[0] as Record<string, unknown>;
    expectObjectKeys(firstEvent, ["id", "slug", "title", "startDate", "startAtUtc", "visibility", "account"]);
    expect(sanitizeForContractSnapshot(firstEvent)).toMatchInlineSnapshot(`
      {
        "account": {
          "displayName": null,
          "username": "events_owner",
        },
        "accountId": "<redacted>",
        "allDay": true,
        "canceled": false,
        "createdAt": "<redacted>",
        "description": null,
        "endDate": null,
        "eventTimezone": "UTC",
        "id": "<redacted>",
        "image": null,
        "location": null,
        "ogImageUrl": null,
        "slug": "e-contract-1",
        "source": "local",
        "startAtUtc": "<redacted>",
        "startDate": "2026-01-01",
        "tags": [],
        "timezoneQuality": "exact_tzid",
        "title": "Contract Event 1",
        "updatedAt": "<redacted>",
        "url": null,
        "visibility": "public",
      }
    `);
  });

  it("GET /events rejects invalid cursor", async () => {
    const { app } = createContractTestApp();
    const res = await app.request("http://localhost/api/v1/events?cursor=invalid");
    await expectErrorResponse(res, 400, { errorMatches: /cursor/i });
  });

  it("GET /events/timeline requires auth", async () => {
    const { app } = createContractTestApp();
    const res = await app.request("http://localhost/api/v1/events/timeline");
    await expectAuthFailure(res);
  });

  it("GET /events/timeline rejects malformed cursor", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_timeline_cursor", username: "timeline_cursor_user" });
    const authApp = fixture.asUser(user);

    const res = await authApp.request("http://localhost/api/v1/events/timeline?cursor=invalid");
    await expectErrorResponse(res, 400, { errorMatches: /cursor/i });
  });

  it("POST /events/rsvp returns 400 for malformed JSON", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_rsvp", username: "contract_rsvp" });
    const authApp = fixture.asUser(user);

    const res = await authApp.request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    await expectErrorResponse(res, 400);
  });

  it("POST /events requires auth", async () => {
    const { app } = createContractTestApp();
    const res = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Unauthorized event" }),
    });
    await expectAuthFailure(res);
  });

  it("POST /events returns 400 for malformed JSON", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_create_bad_json", username: "create_bad_json" });
    const authApp = fixture.asUser(user);
    const res = await authApp.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    await expectErrorResponse(res, 400);
  });

  it("POST /events rejects invalid create payload classes", async () => {
    const fixture = createContractTestApp();
    const user = fixture.seedUser({ id: "u_create_matrix", username: "create_matrix" });
    const authApp = fixture.asUser(user);

    const cases: Array<{
      name: string;
      payload: Record<string, unknown>;
      status: number;
      errorPattern: RegExp;
    }> = [
      {
        name: "missing title",
        payload: { startDate: "2026-07-20", eventTimezone: "UTC" },
        status: 400,
        errorPattern: /title|start/i,
      },
      {
        name: "missing date/dateTime",
        payload: { title: "No date", eventTimezone: "UTC" },
        status: 400,
        errorPattern: /title|start/i,
      },
      {
        name: "startDate wrong type",
        payload: { ...buildValidCreatePayload(), startDate: 123 },
        status: 400,
        errorPattern: /title|start/i,
      },
      {
        name: "eventTimezone wrong type",
        payload: { ...buildValidCreatePayload(), eventTimezone: 123 },
        status: 400,
        errorPattern: /timezone/i,
      },
      {
        name: "invalid timezone",
        payload: { ...buildValidCreatePayload(), eventTimezone: "Mars/Olympus" },
        status: 400,
        errorPattern: /timezone/i,
      },
      {
        name: "invalid visibility",
        payload: { ...buildValidCreatePayload(), visibility: "team_only" },
        status: 400,
        errorPattern: /visibility/i,
      },
      {
        name: "allDay with startDateTime",
        payload: { ...buildValidCreatePayload(), startDateTime: "2026-07-20T12:00:00.000Z" },
        status: 400,
        errorPattern: /date|time/i,
      },
    ];

    for (const testCase of cases) {
      const res = await authApp.request("http://localhost/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(testCase.payload),
      });
      await expectErrorResponse(res, testCase.status, { errorMatches: testCase.errorPattern });
    }
  });

  it("PUT /events/:id returns 400 for malformed JSON", async () => {
    const fixture = createContractTestApp();
    const owner = fixture.seedUser({ id: "u_update_bad_json", username: "update_bad_json" });
    const event = fixture.seedEvent({
      id: "e_update_bad_json",
      accountId: owner.id,
      slug: "update-bad-json",
      title: "Update bad json",
      startDate: "2026-07-21",
      startAtUtc: "2026-07-21T00:00:00.000Z",
    });
    const authApp = fixture.asUser(owner);
    const res = await authApp.request(`http://localhost/api/v1/events/${event.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    await expectErrorResponse(res, 400);
  });

  it("PUT /events/:id rejects invalid update payload classes", async () => {
    const fixture = createContractTestApp();
    const owner = fixture.seedUser({ id: "u_update_matrix", username: "update_matrix" });
    const event = fixture.seedEvent({
      id: "e_update_matrix",
      accountId: owner.id,
      slug: "update-matrix",
      title: "Update matrix",
      startDate: "2026-07-22",
      startAtUtc: "2026-07-22T00:00:00.000Z",
    });
    const authApp = fixture.asUser(owner);

    const cases: Array<{
      name: string;
      payload: Record<string, unknown>;
      status: number;
      errorPattern: RegExp;
    }> = [
      {
        name: "title wrong type",
        payload: { title: 100 },
        status: 400,
        errorPattern: /request/i,
      },
      {
        name: "eventTimezone wrong type",
        payload: { eventTimezone: 123 },
        status: 400,
        errorPattern: /request/i,
      },
      {
        name: "invalid timezone value",
        payload: { eventTimezone: "Invalid/Zone" },
        status: 400,
        errorPattern: /request/i,
      },
      {
        name: "invalid visibility",
        payload: { visibility: "org-only" },
        status: 400,
        errorPattern: /visibility/i,
      },
      {
        name: "allDay wrong type",
        payload: { allDay: "true" },
        status: 400,
        errorPattern: /date|time|request/i,
      },
      {
        name: "partial temporal update with invalid type",
        payload: { startDate: "2026-08-01", endDate: 123 },
        status: 400,
        errorPattern: /date|time|request/i,
      },
      {
        name: "allDay with startDateTime",
        payload: { allDay: true, startDateTime: "2026-08-01T09:30:00.000Z" },
        status: 400,
        errorPattern: /date|time/i,
      },
    ];

    for (const testCase of cases) {
      const res = await authApp.request(`http://localhost/api/v1/events/${event.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(testCase.payload),
      });
      await expectErrorResponse(res, testCase.status, { errorMatches: testCase.errorPattern });
    }
  });

  it("POST then PUT preserves key invariants and persists critical fields", async () => {
    const fixture = createContractTestApp();
    const owner = fixture.seedUser({ id: "u_create_update", username: "create_update" });
    const authApp = fixture.asUser(owner);

    const createRes = await authApp.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Contract Created Event",
        startDate: "2026-09-01",
        endDate: "2026-09-02",
        eventTimezone: "Europe/Vienna",
        allDay: true,
        visibility: "public",
      }),
    });
    const created = await expectJsonStatus(createRes, 201);
    expectObjectKeys(created, ["id", "title", "startDate", "eventTimezone", "visibility", "accountId"]);
    expect(created.title).toBe("Contract Created Event");
    expect(created.startDate).toBe("2026-09-01");
    expect(created.eventTimezone).toBe("Europe/Vienna");
    expect(created.visibility).toBe("public");

    const createdId = String(created.id);
    const before = fixture.db
      .prepare("SELECT account_id, created_by_account_id, title, visibility, event_timezone FROM events WHERE id = ?")
      .get(createdId) as {
      account_id: string;
      created_by_account_id: string;
      title: string;
      visibility: string;
      event_timezone: string;
    };
    expect(before.account_id).toBe(owner.id);
    expect(before.created_by_account_id).toBe(owner.id);

    const updateRes = await authApp.request(`http://localhost/api/v1/events/${createdId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Contract Updated Event",
        visibility: "private",
        eventTimezone: "UTC",
      }),
    });
    const updated = await expectJsonStatus(updateRes, 200);
    expectObjectKeys(updated, ["id", "title", "eventTimezone", "visibility", "accountId"]);
    expect(updated.id).toBe(createdId);
    expect(updated.title).toBe("Contract Updated Event");
    expect(updated.eventTimezone).toBe("UTC");
    expect(updated.visibility).toBe("private");

    const after = fixture.db
      .prepare("SELECT account_id, created_by_account_id, title, visibility, event_timezone FROM events WHERE id = ?")
      .get(createdId) as {
      account_id: string;
      created_by_account_id: string;
      title: string;
      visibility: string;
      event_timezone: string;
    };
    expect(after.title).toBe("Contract Updated Event");
    expect(after.visibility).toBe("private");
    expect(after.event_timezone).toBe("UTC");
    expect(after.account_id).toBe(owner.id);
    expect(after.created_by_account_id).toBe(owner.id);
  });

  it("DELETE /events/:id requires auth", async () => {
    const fixture = createContractTestApp();
    const owner = fixture.seedUser({ id: "u_delete_owner", username: "delete_owner" });
    const event = fixture.seedEvent({
      id: "e_delete_target",
      accountId: owner.id,
      slug: "delete-target",
      title: "Delete target",
      startDate: "2026-04-01",
      startAtUtc: "2026-04-01T00:00:00.000Z",
    });

    const res = await fixture.app.request(`http://localhost/api/v1/events/${event.id}`, {
      method: "DELETE",
    });
    await expectAuthFailure(res);
  });
});
