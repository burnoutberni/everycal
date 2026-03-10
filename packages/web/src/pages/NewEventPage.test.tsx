// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  refreshUser: vi.fn(async () => {}),
  user: {
    id: "user-1",
    username: "alice",
    timezone: "America/Los_Angeles",
    dateTimeLocale: "system",
  },
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
  useLocation: () => ["/events/e1/edit", mocks.navigate],
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: mocks.user,
    refreshUser: mocks.refreshUser,
  }),
}));

vi.mock("../hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("../components/RichTextEditor", () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="description-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock("../components/ImagePickerModal", () => ({
  ImagePickerModal: () => null,
}));

vi.mock("../components/LocationMap", () => ({
  LocationMap: () => null,
}));

vi.mock("../components/TimezonePicker", () => ({
  TimezonePicker: ({ id, value, onChange }: { id: string; value: string; onChange: (next: string) => void }) => (
    <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock("../components/TagInput", () => ({
  TagInput: ({ id, value, onChange }: { id: string; value: string; onChange: (next: string) => void }) => (
    <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock("../lib/api", () => ({
  events: {
    update: vi.fn(),
    create: vi.fn(),
  },
  locations: {
    list: vi.fn(async () => []),
    save: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
  },
  images: {
    search: vi.fn(async () => ({ results: [] })),
  },
  identities: {
    list: vi.fn(async () => ({ identities: [] })),
  },
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

import { NewEventPage } from "./NewEventPage";
import { events as eventsApi, type CalEvent } from "../lib/api";

describe("NewEventPage edit timezone behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(eventsApi.update).mockImplementation(async (_id: string, data: any) => ({
      id: "e1",
      slug: "global-meeting",
      title: data.title,
      description: data.description || null,
      startDate: data.startDate,
      endDate: data.endDate || null,
      startAtUtc: "2026-12-01T01:00:00.000Z",
      endAtUtc: "2026-12-01T02:00:00.000Z",
      eventTimezone: data.eventTimezone,
      allDay: false,
      location: null,
      image: null,
      url: null,
      tags: [],
      visibility: "public",
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    } as CalEvent));
  });

  it("submits unchanged wall time in event timezone", async () => {
    const initialEvent: CalEvent = {
      id: "e1",
      slug: "global-meeting",
      accountId: "user-1",
      account: { username: "alice", displayName: "Alice" },
      title: "Global meeting",
      description: "Kickoff",
      startDate: "2026-12-01T10:00:00",
      endDate: "2026-12-01T11:00:00",
      startAtUtc: "2026-12-01T01:00:00.000Z",
      endAtUtc: "2026-12-01T02:00:00.000Z",
      eventTimezone: "Asia/Tokyo",
      allDay: false,
      location: null,
      image: null,
      url: null,
      tags: [],
      visibility: "public",
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    };

    render(<NewEventPage initialEvent={initialEvent} />);

    const startInput = await screen.findByLabelText("startLabel") as HTMLInputElement;
    expect(startInput.value).toBe("2026-12-01T10:00");

    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));

    await waitFor(() => {
      expect(eventsApi.update).toHaveBeenCalledTimes(1);
    });

    const [, payload] = vi.mocked(eventsApi.update).mock.calls[0];
    expect(payload.startDateTime).toBe("2026-12-01T10:00");
    expect(payload.endDateTime).toBe("2026-12-01T11:00");
    expect(payload.eventTimezone).toBe("Asia/Tokyo");
  });
});
