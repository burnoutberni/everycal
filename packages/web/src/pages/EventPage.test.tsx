// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  location: "/@alice/summer-fest",
  navigate: vi.fn(),
  pageContext: undefined as { data?: { event?: unknown } } | undefined,
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
  useLocation: () => [mocks.location, mocks.navigate],
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("../hooks/useHasAdditionalIdentities", () => ({
  useHasAdditionalIdentities: () => ({ hasAdditionalIdentities: false, loading: false }),
}));

vi.mock("../renderer/PageContext", () => ({
  useOptionalPageContext: () => mocks.pageContext,
}));

vi.mock("../components/ProfileCard", () => ({
  ProfileCard: () => null,
  getProfileKey: () => "profile",
}));

vi.mock("../components/LocationMap", () => ({
  LocationMap: () => null,
}));

vi.mock("../components/EventCard", () => ({
  EventCard: () => null,
}));

vi.mock("../components/ImageAttributionBadge", () => ({
  ImageAttributionBadge: () => null,
}));

vi.mock("../components/ActAsActionModal", () => ({
  ActAsActionModal: () => null,
}));

vi.mock("../components/EmbedCodeModal", () => ({
  EmbedCodeModal: () => null,
}));

vi.mock("../components/ReasonModal", () => ({
  ReasonModal: () => null,
}));

vi.mock("../components/ModerationDecisionActions", () => ({
  ModerationDecisionActions: () => null,
}));

vi.mock("../lib/api", () => ({
  events: {
    get: vi.fn(),
    getBySlug: vi.fn(),
    delete: vi.fn(),
    rsvp: vi.fn(),
    repost: vi.fn(),
    unrepost: vi.fn(),
    repostActors: vi.fn(),
    setRepostActors: vi.fn(),
    flag: vi.fn(),
  },
  users: {
    get: vi.fn(async (username: string) => ({ id: `${username}-id`, username, displayName: username })),
    events: vi.fn(async () => ({ events: [] })),
    follow: vi.fn(),
    unfollow: vi.fn(),
    following: vi.fn(async () => ({ users: [] })),
  },
  federation: {
    remoteEvents: vi.fn(async () => ({ events: [] })),
    followedActors: vi.fn(async () => ({ actors: [] })),
    follow: vi.fn(),
    unfollow: vi.fn(),
  },
  identities: {
    list: vi.fn(async () => ({ identities: [] })),
  },
}));

import { EventPage } from "./EventPage";
import { events as eventsApi, type LocalCalEvent } from "../lib/api";

function makeEvent(overrides: Partial<LocalCalEvent> = {}): LocalCalEvent {
  return {
    id: "e1",
    slug: "summer-fest",
    source: "local",
    accountId: "user-1",
    account: { username: "alice", displayName: "Alice" },
    title: "Summer Fest",
    description: "Outdoor show",
    startDate: "2026-08-10T18:00:00",
    endDate: null,
    startAtUtc: "2026-08-10T18:00:00.000Z",
    endAtUtc: null,
    eventTimezone: "UTC",
    allDay: false,
    location: null,
    image: null,
    url: null,
    tags: [],
    visibility: "public",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("EventPage SSR event reuse", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.location = "/@alice/summer-fest";
    mocks.pageContext = undefined;
  });

  it("reuses an SSR event for a matching slug route without refetching or flashing loading", async () => {
    const event = makeEvent();
    mocks.pageContext = { data: { event } };

    render(<EventPage />);

    expect(screen.queryByText("common:loading")).toBeNull();
    expect(screen.getByRole("heading", { name: "Summer Fest" })).toBeTruthy();
    expect(eventsApi.getBySlug).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText("by")).toBeTruthy();
    });
  });

  it("reuses an SSR event for a matching id route without refetching or flashing loading", () => {
    const event = makeEvent();
    mocks.location = "/events/e1";
    mocks.pageContext = { data: { event } };

    render(<EventPage />);

    expect(screen.queryByText("common:loading")).toBeNull();
    expect(screen.getByRole("heading", { name: "Summer Fest" })).toBeTruthy();
    expect(eventsApi.get).not.toHaveBeenCalled();
  });

  it("fetches when the SSR event does not match the requested route", async () => {
    const ssrEvent = makeEvent({ id: "e1", slug: "summer-fest" });
    const fetchedEvent = makeEvent({ id: "e2", slug: "autumn-fest", title: "Autumn Fest" });
    mocks.location = "/@alice/autumn-fest";
    mocks.pageContext = { data: { event: ssrEvent } };
    vi.mocked(eventsApi.getBySlug).mockResolvedValue(fetchedEvent);

    render(<EventPage />);

    await waitFor(() => {
      expect(eventsApi.getBySlug).toHaveBeenCalledWith("alice", "autumn-fest");
    });
    expect(await screen.findByRole("heading", { name: "Autumn Fest" })).toBeTruthy();
  });
});
