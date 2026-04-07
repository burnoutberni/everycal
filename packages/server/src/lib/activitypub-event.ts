const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const AP_CONTEXT = "https://www.w3.org/ns/activitystreams";
export const EVERYCAL_CONTEXT = {
  eventTimezone: "https://everycal.org/ns#eventTimezone",
};

export function toUtcIsoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export function toDateOnlyOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (DATE_ONLY.test(value)) return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s)/);
  return match ? match[1] : undefined;
}

type BuildApEventObjectInput = {
  id: string;
  name: string;
  attributedTo: string;
  to: string[];
  cc: string[];
  allDay: boolean;
  startDate?: unknown;
  endDate?: unknown;
  startAtUtc?: unknown;
  endAtUtc?: unknown;
  content?: string;
  published?: string;
  updated?: string;
  url?: string;
  eventTimezone?: string | null;
  includeContext?: boolean;
};

export function buildApEventObject(input: BuildApEventObjectInput): Record<string, unknown> {
  const startDateOnly = toDateOnlyOrUndefined(input.startDate);
  const endDateOnly = toDateOnlyOrUndefined(input.endDate);
  const startUtc = toUtcIsoOrUndefined(input.startAtUtc);
  const endUtc = toUtcIsoOrUndefined(input.endAtUtc);

  if (input.allDay && !startDateOnly) {
    throw new Error("All-day event missing date-only start");
  }
  if (!input.allDay && !startUtc) {
    throw new Error("Timed event missing UTC start");
  }

  const event: Record<string, unknown> = {
    id: input.id,
    type: "Event",
    name: input.name,
    attributedTo: input.attributedTo,
    to: input.to,
    cc: input.cc,
    startTime: input.allDay ? startDateOnly : startUtc,
  };

  if (input.includeContext) {
    event["@context"] = [AP_CONTEXT, EVERYCAL_CONTEXT];
  }
  if (input.content) event.content = input.content;
  if (input.published) event.published = input.published;
  if (input.updated) event.updated = input.updated;
  if (input.url) event.url = input.url;
  if (input.eventTimezone) event.eventTimezone = input.eventTimezone;

  if (input.allDay) {
    event.allDay = true;
    if (endDateOnly) event.endTime = endDateOnly;
  } else if (endUtc) {
    event.endTime = endUtc;
  }

  return event;
}
