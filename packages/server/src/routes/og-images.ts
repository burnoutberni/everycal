/**
 * OG image generation helpers.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { generateOgImage, getOgImageFilename } from "@everycal/og";
import type { DB } from "../db.js";
import { OG_DIR } from "../lib/paths.js";
import { normalizeEventTimezone } from "../lib/event-timezone.js";

const PUBLIC_ADDRESS = "https://www.w3.org/ns/activitystreams#Public";

function normalizeRecipients(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string");
}

function hasPublicAddress(recipients: string[]): boolean {
  return recipients.includes(PUBLIC_ADDRESS);
}

export function isOgEligibleVisibility(visibility: string | null | undefined): boolean {
  return visibility === "public" || visibility === "unlisted";
}

export function isRemoteActivityOgEligible(
  activity: Record<string, unknown>,
  object: Record<string, unknown>
): boolean {
  const objectTo = normalizeRecipients(object.to);
  const objectCc = normalizeRecipients(object.cc);
  const activityTo = normalizeRecipients(activity.to);
  const activityCc = normalizeRecipients(activity.cc);

  const toRecipients = objectTo.length > 0 ? objectTo : activityTo;
  const ccRecipients = objectCc.length > 0 ? objectCc : activityCc;

  return hasPublicAddress(toRecipients) || hasPublicAddress(ccRecipients);
}

function updateLocalOgImageUrl(db: DB, eventId: string, ogImageUrl: string | null): void {
  try {
    db.prepare("UPDATE events SET og_image_url = ? WHERE id = ?").run(ogImageUrl, eventId);
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes("no such column")) {
      return;
    }
    throw err;
  }
}

function updateRemoteOgImageUrl(db: DB, eventUri: string, ogImageUrl: string | null): void {
  try {
    db.prepare("UPDATE remote_events SET og_image_url = ? WHERE uri = ?").run(ogImageUrl, eventUri);
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes("no such column")) {
      return;
    }
    throw err;
  }
}

export async function generateAndSaveOgImage(db: DB, eventId: string): Promise<string | null> {
  const { writeFile } = await import("node:fs/promises");
  const { existsSync, mkdirSync } = await import("node:fs");

  const event = db.prepare(`
    SELECT e.*, a.preferred_language
    FROM events e
    JOIN accounts a ON e.account_id = a.id
    WHERE e.id = ?
  `).get(eventId) as {
    id: string;
    title: string;
    start_date: string;
    start_at_utc: string | null;
    end_date: string | null;
    end_at_utc: string | null;
    event_timezone: string;
    all_day: number;
    location_name: string | null;
    location_address: string | null;
    location_latitude: number | null;
    location_longitude: number | null;
    location_url: string | null;
    image_url: string | null;
    image_media_type: string | null;
    image_alt: string | null;
    preferred_language: string;
    updated_at: string;
    visibility: string;
  } | undefined;

  if (!event) {
    return null;
  }
  if (!isOgEligibleVisibility(event.visibility)) {
    updateLocalOgImageUrl(db, eventId, null);
    return null;
  }

  const baseEventData = {
    id: event.id,
    title: event.title,
    startDate: event.start_date,
    endDate: event.end_date || undefined,
    eventTimezone: normalizeEventTimezone(event.event_timezone),
    location: event.location_name
      ? {
          name: event.location_name,
          address: event.location_address || undefined,
          latitude: event.location_latitude || undefined,
          longitude: event.location_longitude || undefined,
          url: event.location_url || undefined,
        }
      : undefined,
    image: event.image_url
      ? {
          url: event.image_url,
          mediaType: event.image_media_type || undefined,
          alt: event.image_alt || undefined,
        }
      : undefined,
    visibility: "public" as const,
    createdAt: "",
    updatedAt: "",
  };
  const eventData = event.all_day
    ? {
      ...baseEventData,
      allDay: true as const,
      ...(event.start_at_utc ? { startAtUtc: event.start_at_utc } : {}),
    }
    : {
      ...baseEventData,
      allDay: false as const,
      startDate: event.start_at_utc as string,
      endDate: event.end_at_utc || undefined,
      startAtUtc: event.start_at_utc as string,
      ...(event.end_at_utc ? { endAtUtc: event.end_at_utc } : {}),
    };

  if (!event.all_day && !event.start_at_utc) {
    throw new Error(`Timed event ${event.id} missing start_at_utc for OG generation`);
  }
  if (!event.all_day && event.end_date && !event.end_at_utc) {
    throw new Error(`Timed event ${event.id} missing end_at_utc for OG generation`);
  }

  const locale = event.preferred_language || "en";

  const ogBuffer = await generateOgImage({
    event: eventData,
    locale,
  });

  if (!existsSync(OG_DIR)) {
    mkdirSync(OG_DIR, { recursive: true });
  }

  const ogFilename = getOgImageFilename(eventId);
  const ogPath = join(OG_DIR, ogFilename);
  await writeFile(ogPath, ogBuffer);

  const version = Math.floor(new Date(event.updated_at).getTime() / 1000);
  const ogImageUrl = `/og-images/${eventId}.png?v=${version}`;
  updateLocalOgImageUrl(db, eventId, ogImageUrl);

  return ogImageUrl;
}

function getRemoteOgFilename(eventUri: string): string {
  const digest = createHash("sha256").update(eventUri).digest("hex");
  return `remote-${digest}.png`;
}

export async function generateAndSaveRemoteOgImage(db: DB, eventUri: string): Promise<string | null> {
  const { writeFile } = await import("node:fs/promises");
  const { existsSync, mkdirSync } = await import("node:fs");

  const event = db.prepare(`
    SELECT uri, title, start_date, start_at_utc, end_date, end_at_utc,
           event_timezone, all_day,
           location_name, location_address, location_latitude, location_longitude,
           image_url, image_media_type, image_alt,
           fetched_at, canceled
    FROM remote_events
    WHERE uri = ?
  `).get(eventUri) as {
    uri: string;
    title: string;
    start_date: string;
    start_at_utc: string;
    end_date: string | null;
    end_at_utc: string | null;
    event_timezone: string | null;
    all_day: number;
    location_name: string | null;
    location_address: string | null;
    location_latitude: number | null;
    location_longitude: number | null;
    image_url: string | null;
    image_media_type: string | null;
    image_alt: string | null;
    fetched_at: string;
    canceled: number;
  } | undefined;

  if (!event || event.canceled) return null;

  const baseEventData = {
    id: event.uri,
    title: event.title,
    startDate: event.start_date,
    endDate: event.end_date || undefined,
    eventTimezone: normalizeEventTimezone(event.event_timezone),
    location: event.location_name
      ? {
          name: event.location_name,
          address: event.location_address || undefined,
          latitude: event.location_latitude || undefined,
          longitude: event.location_longitude || undefined,
        }
      : undefined,
    image: event.image_url
      ? {
          url: event.image_url,
          mediaType: event.image_media_type || undefined,
          alt: event.image_alt || undefined,
        }
      : undefined,
    visibility: "public" as const,
    createdAt: "",
    updatedAt: "",
  };

  const eventData = event.all_day
    ? {
        ...baseEventData,
        allDay: true as const,
        ...(event.start_at_utc ? { startAtUtc: event.start_at_utc } : {}),
      }
    : {
        ...baseEventData,
        allDay: false as const,
        startDate: event.start_at_utc,
        endDate: event.end_at_utc || undefined,
        startAtUtc: event.start_at_utc,
        ...(event.end_at_utc ? { endAtUtc: event.end_at_utc } : {}),
      };

  const ogBuffer = await generateOgImage({
    event: eventData,
    locale: "en",
  });

  if (!existsSync(OG_DIR)) {
    mkdirSync(OG_DIR, { recursive: true });
  }

  const ogFilename = getRemoteOgFilename(event.uri);
  const ogPath = join(OG_DIR, ogFilename);
  await writeFile(ogPath, ogBuffer);

  const version = Math.floor(new Date(event.fetched_at).getTime() / 1000);
  const ogImageUrl = `/og-images/${ogFilename}?v=${version}`;
  updateRemoteOgImageUrl(db, event.uri, ogImageUrl);

  return ogImageUrl;
}
