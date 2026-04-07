import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { html } from "satori-html";
import sharp from "sharp";
import type { EveryCalEvent } from "@everycal/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = resolve(__dirname, "../node_modules/@fontsource/bricolage-grotesque/files");

export interface GenerateOgImageOptions {
  event: EveryCalEvent;
  locale: string;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHeaderImage(url: string): Promise<Buffer | null> {
  const IMAGE_FETCH_TIMEOUT = 5000;
  try {
    const response = await fetchWithTimeout(url, IMAGE_FETCH_TIMEOUT);
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const sharpBuffer = Buffer.from(buffer);
    const metadata = await sharp(sharpBuffer).metadata();

    if (!metadata.format) return null;

    return await sharp(sharpBuffer)
      .resize(1200, 630, { fit: "cover" })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

function getLocaleForDate(locale: string): string {
  return locale === "de" ? "de-AT" : "en";
}

function formatTimeOnly(dateStr: string, localeTag: string, timeZone: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString(localeTag, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

function getDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDateTimeRange(
  startDateStr: string,
  endDateStr: string | undefined,
  allDay: boolean,
  locale: string,
  timeZone: string
): string {
  const localeTag = getLocaleForDate(locale);
  const startDate = new Date(startDateStr);

  if (allDay) {
    if (!endDateStr) {
      return startDate.toLocaleDateString(localeTag, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone,
      });
    }
    const endDate = new Date(endDateStr);
    return `${startDate.toLocaleDateString(localeTag, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    })} – ${endDate.toLocaleDateString(localeTag, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    })}`;
  }

  if (!endDateStr) {
    const datePart = startDate.toLocaleDateString(localeTag, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    });
    const timePart = formatTimeOnly(startDateStr, localeTag, timeZone);
    return `${datePart} · ${timePart}`;
  }

  const endDate = new Date(endDateStr);
  const startDay = getDayKey(startDate, timeZone);
  const endDay = getDayKey(endDate, timeZone);

  if (startDay === endDay) {
    const datePart = startDate.toLocaleDateString(localeTag, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    });
    const startTime = formatTimeOnly(startDateStr, localeTag, timeZone);
    const endTime = formatTimeOnly(endDateStr, localeTag, timeZone);
    return `${datePart} · ${startTime} – ${endTime}`;
  }

  const startDateTime = `${startDate.toLocaleDateString(localeTag, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  })} · ${formatTimeOnly(startDateStr, localeTag, timeZone)}`;
  const endDateTime = `${endDate.toLocaleDateString(localeTag, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  })} · ${formatTimeOnly(endDateStr, localeTag, timeZone)}`;

  return `${startDateTime} – ${endDateTime}`;
}

export async function generateOgImage({
  event,
  locale,
}: GenerateOgImageOptions): Promise<Buffer> {
  const [font400, font600, font700] = await Promise.all([
    readFile(join(FONTS_DIR, "bricolage-grotesque-latin-400-normal.woff")),
    readFile(join(FONTS_DIR, "bricolage-grotesque-latin-600-normal.woff")),
    readFile(join(FONTS_DIR, "bricolage-grotesque-latin-700-normal.woff")),
  ]);

  const dateTimeStr = formatDateTimeRange(
    event.startDate,
    event.endDate,
    event.allDay ?? false,
    locale,
    event.allDay ? "UTC" : (event.eventTimezone || "UTC")
  );
  const title = event.title || "Event";
  const hasLocation = !!event.location;
  const locationName = event.location?.name || "";
  const locationAddress = event.location?.address || "";
  const locationStyle = hasLocation
    ? "display: flex;"
    : "display: none;";

  const headerImageBuffer = event.image?.url
    ? await fetchHeaderImage(event.image.url)
    : null;

  const hasHeaderImage = !!headerImageBuffer;
  const headerImageStyle = hasHeaderImage
    ? "background: transparent;"
    : "background: #0d0d0d;";

  const markup = html`
    <div style="display: flex; flex-direction: column; justify-content: flex-end; width: 100%; height: 100%; padding: 40px; box-sizing: border-box; ${headerImageStyle}">
      <div style="position: absolute; top: 40px; left: 40px; display: flex; align-items: center; gap: 0.5rem;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="44" height="44" fill="none">
          <circle cx="12" cy="16" r="10" style="fill: #F59E0B;"></circle>
          <circle cx="20" cy="16" r="10" style="fill: #FCD34D; fill-opacity: 0.9;"></circle>
        </svg>
        <span style="font-size: 33px; font-weight: 700; color: #e0e0e0; letter-spacing: -0.02em;">EveryCal</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 16px; color: #e0e0e0; font-family: 'Bricolage Grotesque'; width: 100%;">
        <div style="font-size: 33px; color: #FFE185; font-weight: 600;">
          ${escapeHtml(dateTimeStr)}
        </div>

        <div style="font-size: 55px; color: #e0e0e0; font-weight: 700; line-height: 1.1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;">
          ${escapeHtml(title)}
        </div>

        <div style="display: flex; width: 100%; align-items: center; gap: 8px; font-size: 20px; color: #e0e0e0; ${locationStyle}">
          <svg width="33" height="33" viewBox="0 0 24 24" fill="none" stroke="#e0e0e0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
            <circle cx="12" cy="10" r="3"></circle>
          </svg>
          <span style="font-size: 33px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(locationName)}${locationAddress ? ` – ${escapeHtml(locationAddress)}` : ""}</span>
        </div>
      </div>
    </div>
  `;

  const svgBuffer = await satori(
    markup as unknown as Parameters<typeof satori>[0],
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: "Bricolage Grotesque",
          data: font400,
          weight: 400,
          style: "normal",
        },
        {
          name: "Bricolage Grotesque",
          data: font600,
          weight: 600,
          style: "normal",
        },
        {
          name: "Bricolage Grotesque",
          data: font700,
          weight: 700,
          style: "normal",
        },
      ],
    }
  );

  let svgPng: Buffer;
  try {
    svgPng = await sharp(Buffer.from(svgBuffer)).png().toBuffer();
  } catch (err) {
    console.error("[OG] Failed to convert SVG to PNG:", {
      eventId: event.id,
      title: event.title?.slice(0, 50),
      hasHeaderImage,
      svgLength: svgBuffer.length,
    });
    throw err;
  }

  let finalPng: Buffer;
  if (headerImageBuffer) {
    const gradientSvg = `
      <svg width="1200" height="630">
        <defs>
          <linearGradient id="grad" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" style="stop-color:rgba(0,0,0,0.7);stop-opacity:1" />
            <stop offset="50%" style="stop-color:rgba(0,0,0,0.3);stop-opacity:1" />
            <stop offset="100%" style="stop-color:rgba(0,0,0,0);stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)"/>
      </svg>
    `;
    const gradientBuffer = await sharp(Buffer.from(gradientSvg)).png().toBuffer();

    finalPng = await sharp(headerImageBuffer)
      .composite([
        { input: gradientBuffer },
        { input: svgPng },
      ])
      .png()
      .toBuffer();
  } else {
    finalPng = svgPng;
  }

  return finalPng;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function getOgImageFilename(eventId: string): string {
  return `${eventId}.png`;
}
