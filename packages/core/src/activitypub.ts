/**
 * Convert between EveryCal events and ActivityPub Event objects.
 *
 * Follows https://www.w3.org/TR/activitystreams-vocabulary/#dfn-event
 * with extensions for images (as attachments) and visibility (as audience addressing).
 */

import { EveryCalEvent, EventVisibility } from "./event.js";

/** Minimal AP object shape — we'll flesh this out as federation grows. */
export interface APEvent {
  "@context": string | string[];
  id: string;
  type: "Event";
  name: string;
  content?: string;
  startTime: string;
  endTime?: string;
  location?: APPlace;
  attachment?: APImage[];
  tag?: APTag[];
  url?: string;
  attributedTo?: string;
  to: string[];
  cc: string[];
  published: string;
  updated: string;
}

interface APPlace {
  type: "Place";
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  url?: string;
}

interface APImage {
  type: "Image";
  url: string;
  mediaType?: string;
  name?: string;
  width?: number;
  height?: number;
}

interface APTag {
  type: "Hashtag";
  name: string;
}

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

function visibilityToAddressing(
  visibility: EventVisibility,
  organizer?: string
): { to: string[]; cc: string[] } {
  const followers = organizer ? `${organizer}/followers` : undefined;
  switch (visibility) {
    case "public":
      return { to: [PUBLIC], cc: followers ? [followers] : [] };
    case "unlisted":
      return { to: followers ? [followers] : [], cc: [PUBLIC] };
    case "followers_only":
      return { to: followers ? [followers] : [], cc: [] };
    case "private":
      return { to: [], cc: [] };
  }
}

function addressingToVisibility(to: string[], cc: string[]): EventVisibility {
  if (to.includes(PUBLIC)) return "public";
  if (cc.includes(PUBLIC)) return "unlisted";
  if (to.length > 0) return "followers_only";
  return "private";
}

/** Convert an EveryCal event to an ActivityPub Event object. */
export function toActivityPubEvent(event: EveryCalEvent): APEvent {
  const { to, cc } = visibilityToAddressing(event.visibility, event.organizer);

  const ap: APEvent = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: event.id,
    type: "Event",
    name: event.title,
    startTime: event.startDate,
    to,
    cc,
    published: event.createdAt,
    updated: event.updatedAt,
  };

  if (event.description) ap.content = event.description;
  if (event.endDate) ap.endTime = event.endDate;
  if (event.url) ap.url = event.url;
  if (event.organizer) ap.attributedTo = event.organizer;

  if (event.location) {
    ap.location = {
      type: "Place",
      name: event.location.name,
      ...(event.location.address && { address: event.location.address }),
      ...(event.location.latitude != null && { latitude: event.location.latitude }),
      ...(event.location.longitude != null && { longitude: event.location.longitude }),
      ...(event.location.url && { url: event.location.url }),
    };
  }

  if (event.image) {
    ap.attachment = [
      {
        type: "Image",
        url: event.image.url,
        ...(event.image.mediaType && { mediaType: event.image.mediaType }),
        ...(event.image.alt && { name: event.image.alt }),
        ...(event.image.width != null && { width: event.image.width }),
        ...(event.image.height != null && { height: event.image.height }),
      },
    ];
  }

  if (event.tags && event.tags.length > 0) {
    ap.tag = event.tags.map((t) => ({
      type: "Hashtag" as const,
      name: t.startsWith("#") ? t : `#${t}`,
    }));
  }

  return ap;
}

/** Convert an ActivityPub Event object back to an EveryCal event. */
export function fromActivityPubEvent(ap: APEvent): EveryCalEvent {
  const visibility = addressingToVisibility(ap.to ?? [], ap.cc ?? []);
  const image = ap.attachment?.find((a) => a.type === "Image");
  const location = ap.location
    ? {
        name: ap.location.name,
        ...(ap.location.address !== undefined ? { address: ap.location.address } : {}),
        ...(ap.location.latitude !== undefined ? { latitude: ap.location.latitude } : {}),
        ...(ap.location.longitude !== undefined ? { longitude: ap.location.longitude } : {}),
        ...(ap.location.url !== undefined ? { url: ap.location.url } : {}),
      }
    : undefined;
  const eventImage = image
    ? {
        url: image.url,
        ...(image.mediaType !== undefined ? { mediaType: image.mediaType } : {}),
        ...(image.name !== undefined ? { alt: image.name } : {}),
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
      }
    : undefined;

  return {
    id: ap.id,
    title: ap.name,
    startDate: ap.startTime,
    ...(ap.content !== undefined ? { description: ap.content } : {}),
    ...(ap.endTime !== undefined ? { endDate: ap.endTime } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(eventImage !== undefined ? { image: eventImage } : {}),
    ...(ap.url !== undefined ? { url: ap.url } : {}),
    ...(ap.tag !== undefined ? { tags: ap.tag.map((t) => t.name.replace(/^#/, "")) } : {}),
    ...(ap.attributedTo !== undefined ? { organizer: ap.attributedTo } : {}),
    visibility,
    createdAt: ap.published,
    updatedAt: ap.updated,
  };
}
