/**
 * Core event model for EveryCal.
 *
 * Maps to iCalendar VEVENT fields with extensions for federation (ActivityPub)
 * and rich media (header images).
 */

/** Visibility controls who can see an event over federation / API. */
export type EventVisibility = "public" | "unlisted" | "followers_only" | "private";
export type TimezoneQuality = "exact_tzid" | "offset_only" | "unknown";

/** All valid visibility values as a runtime-checkable array. */
export const EVENT_VISIBILITIES: readonly EventVisibility[] = [
  "public",
  "unlisted",
  "followers_only",
  "private",
] as const;

/** Check whether a string is a valid EventVisibility. */
export function isValidVisibility(value: unknown): value is EventVisibility {
  return typeof value === "string" && (EVENT_VISIBILITIES as readonly string[]).includes(value);
}

/** A geographical or named location. */
export interface EventLocation {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  url?: string;
}

/** Attribution for externally sourced images (Unsplash, Openverse). */
export interface ImageAttribution {
  source: "unsplash" | "openverse";
  /** Image title (e.g. Openverse title, or "Photo" for Unsplash) */
  title?: string;
  /** Link to image source (photo page, original landing page) */
  sourceUrl?: string;
  /** Photographer/creator name */
  creator?: string;
  /** Link to creator profile (with UTM for Unsplash) */
  creatorUrl?: string;
  /** License identifier (e.g. "cc0", "by") */
  license?: string;
  /** License URL */
  licenseUrl?: string;
  /** Full attribution text (Openverse provides this) */
  attribution?: string;
  /** Unsplash: trigger download tracking when user selects */
  downloadLocation?: string;
}

/** An image attachment (header image, poster, etc.). */
export interface EventImage {
  url: string;
  mediaType?: string; // e.g. "image/jpeg"
  alt?: string;
  width?: number;
  height?: number;
  /** Attribution for Unsplash/Openverse images (required for proper crediting) */
  attribution?: ImageAttribution;
}

/**
 * The canonical EveryCal event object.
 *
 * Field naming follows iCalendar where possible.
 */
type EveryCalEventBase = {
  /** Globally unique ID (URI). For federated events this is the ActivityPub id. */
  id: string;

  /** Short title (iCal SUMMARY). */
  title: string;

  /** Longer description, may contain basic HTML (iCal DESCRIPTION). */
  description?: string;

  /** Start date/time in ISO 8601. */
  startDate: string;

  /** End date/time in ISO 8601. Absent for open-ended events. */
  endDate?: string;

  /** Absolute UTC instant for start when known/derivable. */
  startAtUtc: string;

  /** Absolute UTC instant for end when known/derivable. */
  endAtUtc?: string;

  /** IANA timezone when known (e.g. Europe/Vienna). */
  eventTimezone?: string;

  /** Quality marker for imported timezone precision. */
  timezoneQuality?: TimezoneQuality;

  /** True if this is an all-day event (no specific time). */
  allDay?: boolean;

  /** Location info. */
  location?: EventLocation;

  /** Header / poster image. Not part of standard iCal, carried as AP attachment. */
  image?: EventImage;

  /** Canonical URL for this event (e.g. venue website link). */
  url?: string;

  /** Categories / tags. */
  tags?: string[];

  /** Who is publishing this event (ActivityPub actor URI). */
  organizer?: string;

  /** Visibility / privacy level. */
  visibility: EventVisibility;

  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
};

type EveryCalTimedEvent = EveryCalEventBase & {
  allDay?: false;
  startAtUtc: string;
};

type EveryCalAllDayEvent = Omit<EveryCalEventBase, "startAtUtc"> & {
  allDay: true;
  startAtUtc?: string;
};

export type EveryCalEvent = EveryCalTimedEvent | EveryCalAllDayEvent;
