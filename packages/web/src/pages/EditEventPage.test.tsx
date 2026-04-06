// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  user: {
    id: "user-1",
    username: "alice",
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock("../lib/api", () => ({
  events: {
    get: vi.fn(),
    getBySlug: vi.fn(),
  },
  identities: {
    list: vi.fn(async () => ({ identities: [] })),
  },
}));

vi.mock("./NewEventPage", () => ({
  NewEventPage: () => <div data-testid="new-event-page">new-event-page</div>,
}));

import { EditEventPage } from "./EditEventPage";
import { events as eventsApi, type LocalCalEvent } from "../lib/api";

describe("EditEventPage editable-event contract", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders edit form when local event includes timezone", async () => {
    const event: LocalCalEvent = {
      id: "e1",
      source: "local",
      accountId: "user-1",
      title: "Town Hall",
      description: null,
      startDate: "2026-02-15T18:00:00",
      endDate: "2026-02-15T19:00:00",
      startAtUtc: "2026-02-15T17:00:00.000Z",
      endAtUtc: "2026-02-15T18:00:00.000Z",
      eventTimezone: "Europe/Vienna",
      allDay: false,
      location: null,
      image: null,
      url: null,
      tags: [],
      visibility: "public",
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    };
    vi.mocked(eventsApi.get).mockResolvedValue(event);

    render(<EditEventPage id="e1" />);

    await waitFor(() => {
      expect(screen.getByTestId("new-event-page")).toBeTruthy();
    });
  });

  it("rejects non-editable payloads missing timezone", async () => {
    vi.mocked(eventsApi.get).mockResolvedValue({
      id: "e1",
      source: "local",
      accountId: "user-1",
      title: "Legacy Row",
      description: null,
      startDate: "2026-02-15T18:00:00",
      endDate: null,
      startAtUtc: "2026-02-15T18:00:00.000Z",
      endAtUtc: null,
      allDay: false,
      location: null,
      image: null,
      url: null,
      tags: [],
      visibility: "public",
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    } as any);

    render(<EditEventPage id="e1" />);

    await waitFor(() => {
      expect(screen.getByText("createEvent:notAuthorized")).toBeTruthy();
    });
    expect(screen.queryAllByTestId("new-event-page")).toHaveLength(0);
  });
});
