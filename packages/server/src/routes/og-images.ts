/**
 * OG Image generation API routes.
 */

import { Hono } from "hono";
import { join } from "node:path";
import { generateOgImage, getOgImageFilename } from "@everycal/og";
import type { DB } from "../db.js";
import { OG_DIR } from "../lib/paths.js";

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
  } | undefined;

  if (!event) {
    return null;
  }

  const baseEventData = {
    id: event.id,
    title: event.title,
    startDate: event.start_date,
    endDate: event.end_date || undefined,
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
      startAtUtc: event.start_at_utc as string,
    };

  if (!event.all_day && !event.start_at_utc) {
    throw new Error(`Timed event ${event.id} missing start_at_utc for OG generation`);
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
  db.prepare("UPDATE events SET og_image_url = ? WHERE id = ?").run(ogImageUrl, eventId);

  return ogImageUrl;
}

interface OgImageBody {
  eventId: string;
}

export function ogImageRoutes(db: DB): Hono {
  const router = new Hono();

  router.post("/", async (c) => {
    const body = await c.req.json<OgImageBody>();
    const { eventId } = body;

    if (!eventId) {
      return c.json({ error: "eventId is required" }, 400);
    }

    const ogImageUrl = await generateAndSaveOgImage(db, eventId);
    if (!ogImageUrl) {
      return c.json({ error: "Event not found" }, 404);
    }

    return c.json({ success: true, url: ogImageUrl });
  });

  return router;
}
