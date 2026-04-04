import type { PageContextServer } from "vike/types";
import type { SsrInitialData } from "@everycal/core";
import { events as eventsApi, auth as authApi, createApiRequestContext, type CalEvent } from "../../../lib/api";
import { formatEventDateTime } from "../../../lib/formatEventDateTime";

type EventPageContext = PageContextServer & { initialData?: SsrInitialData };

type SsrTimedEventModel = Pick<Extract<CalEvent, { allDay: false }>, "title" | "startDate" | "endDate" | "startAtUtc" | "endAtUtc" | "allDay" | "location" | "ogImageUrl" | "image">;
type SsrAllDayEventModel = Pick<Extract<CalEvent, { allDay: true }>, "title" | "startDate" | "endDate" | "startAtUtc" | "endAtUtc" | "allDay" | "location" | "ogImageUrl" | "image">;
type SsrEventModel = SsrTimedEventModel | SsrAllDayEventModel;

function formatEventDescription(event: SsrEventModel): string {
  const dateTime = formatEventDateTime(event, true, { locale: "en", allDayLabel: "All day" });
  if (!dateTime) return event.location?.name || "";
  return event.location?.name ? `${dateTime} • ${event.location.name}` : dateTime;
}

export async function data(pageContext: PageContextServer) {
    const { username, slug } = pageContext.routeParams;
    if (!username || !slug) throw new Error("Missing route params");

    const initialData = (pageContext as EventPageContext).initialData;
    if (initialData?.kind === "event" && initialData.username === username && initialData.slug === slug) {
        const event = initialData.event as SsrEventModel | null;
        return {
            user: initialData.user || null,
            event,
            title: event ? event.title : "Event not found",
            description: event
                ? formatEventDescription(event)
                : "The event you are looking for does not exist.",
            ogImageUrl: event?.ogImageUrl || event?.image?.url || null,
        };
    }

    const requestContext = createApiRequestContext({
        headersOriginal: pageContext.headersOriginal as Record<string, string | string[] | undefined>,
    });
    const hasSessionCookie = !!requestContext.cookie && /(?:^|;\s*)everycal_session=/.test(requestContext.cookie);
    const authPromise = hasSessionCookie ? authApi.me(requestContext).catch(() => null) : Promise.resolve(null);

    let event = null;
    let user = null;
    try {
        const eventPromise = eventsApi.getBySlug(username, slug, requestContext);

        const [authRes, eventRes] = await Promise.all([
            authPromise,
            eventPromise,
        ]);

        user = authRes;
        event = eventRes;
    } catch (err) {
        console.error("Error fetching event in SSR:", err);
        event = null;
    }

    return {
        user,
        event,
        title: event ? event.title : "Event not found",
        description: event
            ? formatEventDescription(event)
            : "The event you are looking for does not exist.",
        ogImageUrl: event?.ogImageUrl || event?.image?.url || null
    };
}
