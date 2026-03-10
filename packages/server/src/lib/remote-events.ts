import type { DB } from "../db.js";
import { sanitizeHtml, stripHtml } from "./security.js";
import { uniqueRemoteEventSlug } from "./slugs.js";
import { normalizeApTemporal, type NormalizedRemoteTemporal } from "./timezone.js";

interface UpsertRemoteEventOptions {
  clearCanceled?: boolean;
  temporal?: NormalizedRemoteTemporal;
}

function extractLocationAddress(location?: Record<string, unknown>): string | null {
  if (!location?.address) return null;
  if (typeof location.address === "string") return stripHtml(location.address);
  const addr = location.address as Record<string, string>;
  return [addr.streetAddress, addr.postalCode, addr.addressLocality, addr.addressCountry]
    .filter(Boolean)
    .map((s) => stripHtml(s))
    .join(", ");
}

export function upsertRemoteEvent(
  db: DB,
  object: Record<string, unknown>,
  actorUri: string,
  options: UpsertRemoteEventOptions = {},
): { uri: string; slug: string } {
  const clearCanceled = options.clearCanceled === true;
  const tags = (object.tag as Array<{ name: string }>) || [];
  const tagString = tags
    .map((t) => stripHtml(t.name?.replace(/^#/, "") || ""))
    .filter(Boolean)
    .join(",");

  const title =
    typeof object.name === "string"
      ? stripHtml(object.name)
      : typeof object.title === "string"
        ? stripHtml(object.title)
        : "";
  const description = typeof object.content === "string" ? sanitizeHtml(object.content) : null;
  const temporal = options.temporal ?? normalizeApTemporal(object);
  const startDate = temporal.startDate;
  const endDate = temporal.endDate;

  const loc = object.location as Record<string, unknown> | undefined;
  const locationAddress = extractLocationAddress(loc);

  const attachments = (object.attachment as Array<Record<string, unknown>>) || [];
  const image = attachments.find((a) => a.type === "Image" || a.type === "Document");
  const imageAttribution = image?.attribution
    ? (typeof image.attribution === "string"
        ? (() => { try { return JSON.parse(image.attribution as string); } catch { return null; } })()
        : image.attribution)
    : null;
  const imageAttributionJson = imageAttribution && typeof imageAttribution === "object"
    ? JSON.stringify(imageAttribution)
    : null;

  const uri = object.id as string;
  const existing = db.prepare("SELECT slug FROM remote_events WHERE uri = ?").get(uri) as { slug: string | null } | undefined;
  if (existing) {
    const resolvedSlug = existing.slug || uniqueRemoteEventSlug(db, actorUri, title || "event");
    db.prepare(
      `UPDATE remote_events SET
        slug = ?,
        title = ?, description = ?, start_date = ?, end_date = ?,
        start_at_utc = ?, end_at_utc = ?, event_timezone = ?, timezone_quality = ?,
        location_name = ?, location_address = ?, location_latitude = ?, location_longitude = ?,
        image_url = ?, image_media_type = ?, image_alt = ?, image_attribution = ?,
        url = ?, tags = ?, raw_json = ?, published = ?, updated = ?, fetched_at = datetime('now')${clearCanceled ? ", canceled = 0" : ""}
       WHERE uri = ?`
    ).run(
      resolvedSlug,
      title,
      description,
      startDate,
      endDate,
      temporal.startAtUtc,
      temporal.endAtUtc,
      temporal.eventTimezone,
      temporal.timezoneQuality,
      loc?.name ? stripHtml(loc.name as string) : null,
      locationAddress,
      (loc?.latitude as number) ?? null,
      (loc?.longitude as number) ?? null,
      (image?.url as string) || null,
      (image?.mediaType as string) || null,
      (image?.name as string) || null,
      imageAttributionJson,
      (object.url as string) || null,
      tagString || null,
      JSON.stringify(object).slice(0, 100_000),
      (object.published as string) || null,
      (object.updated as string) || null,
      uri,
    );
    return { uri, slug: resolvedSlug };
  }

  const slug = uniqueRemoteEventSlug(db, actorUri, title);
  db.prepare(
    `INSERT INTO remote_events (uri, actor_uri, slug, title, description, start_date, end_date,
      start_at_utc, end_at_utc, event_timezone, timezone_quality,
      location_name, location_address, location_latitude, location_longitude,
      image_url, image_media_type, image_alt, image_attribution, url, tags, raw_json, published, updated, canceled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    actorUri,
    slug,
    title,
    description,
    startDate,
    endDate,
    temporal.startAtUtc,
    temporal.endAtUtc,
    temporal.eventTimezone,
    temporal.timezoneQuality,
    loc?.name ? stripHtml(loc.name as string) : null,
    locationAddress,
    (loc?.latitude as number) ?? null,
    (loc?.longitude as number) ?? null,
    (image?.url as string) || null,
    (image?.mediaType as string) || null,
    (image?.name as string) || null,
    imageAttributionJson,
    (object.url as string) || null,
    tagString || null,
    JSON.stringify(object).slice(0, 100_000),
    (object.published as string) || null,
    (object.updated as string) || null,
    0,
  );

  return { uri, slug };
}
