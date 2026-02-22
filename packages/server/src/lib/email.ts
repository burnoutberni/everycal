/**
 * Email sending via SMTP (nodemailer).
 * Fails gracefully if SMTP is not configured.
 */

import nodemailer from "nodemailer";
import { emailT } from "./email-i18n.js";
import type { Transporter } from "nodemailer";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const from = process.env.SMTP_FROM;

  if (!host || !port || !from) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: parseInt(port, 10),
    secure: process.env.SMTP_SECURE === "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });

  return transporter;
}

function baseUrl(): string {
  return process.env.BASE_URL || "http://localhost:3000";
}

/** Check if email sending is configured. */
export function isEmailConfigured(): boolean {
  return getTransporter() !== null;
}

/** Send verification email with link. */
export async function sendVerificationEmail(
  to: string,
  token: string,
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.SKIP_EMAIL_VERIFICATION === "true") {
      console.log(`[dev] Verification link: ${baseUrl()}/verify-email?token=${token}`);
      return;
    }
    console.warn("SMTP not configured; verification email not sent");
    return;
  }

  const url = `${baseUrl()}/verify-email?token=${token}`;
  const body = emailT(locale, "verification.body");
  const expires = emailT(locale, "verification.expires");
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "verification.subject"),
    text: `${body}\n\n${url}\n\n${expires}`,
    html: `<p>${body}</p><p><a href="${url}">${url}</a></p><p>${expires}</p>`,
  });
}

/** Send welcome email after verification. */
export async function sendWelcomeEmail(
  to: string,
  username: string,
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.SKIP_EMAIL_VERIFICATION === "true") {
      console.log(`[dev] Welcome email skipped (SMTP not configured)`);
      return;
    }
    return;
  }

  const url = baseUrl();
  const body = emailT(locale, "welcome.body", { username });
  const getStarted = emailT(locale, "welcome.getStarted");
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "welcome.subject"),
    text: `${body}\n\n${getStarted} at ${url}`,
    html: `<p>${body}</p><p><a href="${url}">${getStarted}</a></p>`,
  });
}

/** Send email change verification (add or change email on existing account). */
export async function sendEmailChangeVerificationEmail(
  to: string,
  token: string,
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.SKIP_EMAIL_VERIFICATION === "true") {
      console.log(`[dev] Email change verification link: ${baseUrl()}/verify-email?token=${token}`);
      return;
    }
    console.warn("SMTP not configured; email change verification not sent");
    return;
  }

  const url = `${baseUrl()}/verify-email?token=${token}`;
  const body = emailT(locale, "emailChange.body");
  const expires = emailT(locale, "emailChange.expires");
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "emailChange.subject"),
    text: `${body}\n\n${url}\n\n${expires}`,
    html: `<p>${body}</p><p><a href="${url}">${url}</a></p><p>${expires}</p>`,
  });
}

/** Send password reset email. */
export async function sendPasswordResetEmail(
  to: string,
  token: string,
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.SKIP_EMAIL_VERIFICATION === "true") {
      console.log(`[dev] Reset link: ${baseUrl()}/reset-password?token=${token}`);
      return;
    }
    console.warn("SMTP not configured; password reset email not sent");
    return;
  }

  const url = `${baseUrl()}/reset-password?token=${token}`;
  const body = emailT(locale, "passwordReset.body");
  const expires = emailT(locale, "passwordReset.expires");
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "passwordReset.subject"),
    text: `${body}\n\n${url}\n\n${expires}`,
    html: `<p>${body}</p><p><a href="${url}">${url}</a></p><p>${expires}</p>`,
  });
}

export interface EventInfo {
  id: string;
  title: string;
  startDate: string;
  endDate?: string | null;
  allDay?: boolean;
  location?: { name?: string } | null;
  url?: string | null;
}

/** Build event link for emails. Local events use /events/{id}; remote events use url or omit. */
function getEventLink(event: EventInfo): string | null {
  const isRemote = event.id.startsWith("http://") || event.id.startsWith("https://");
  if (isRemote) return event.url || null;
  return `${baseUrl()}/events/${event.id}`;
}

/** Send event reminder. */
export async function sendEventReminder(
  to: string,
  event: EventInfo,
  hoursAhead: number,
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) return;

  const eventUrl = getEventLink(event);
  const localeTag = locale === "de" ? "de-AT" : "en";
  const timeStr = event.allDay
    ? new Date(event.startDate).toLocaleDateString(localeTag)
    : new Date(event.startDate).toLocaleString(localeTag);
  const at = emailT(locale, "reminder.at");
  const locationStr = event.location?.name ? `${at}${event.location.name}` : "";
  const viewDetails = emailT(locale, "reminder.viewDetails");
  const starts = emailT(locale, "reminder.starts");
  const detailsBlock = eventUrl ? `\n\n${viewDetails}: ${eventUrl}` : "";
  const detailsHtml = eventUrl ? `<p><a href="${eventUrl}">${viewDetails}</a></p>` : "";

  const subject =
    hoursAhead === 1
      ? emailT(locale, "reminder.subject_one", { title: event.title })
      : emailT(locale, "reminder.subject", { title: event.title, hours: String(hoursAhead) });

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text: `${event.title} ${starts} ${timeStr}${locationStr}.${detailsBlock}`,
    html: `<p><strong>${event.title}</strong> ${starts} ${timeStr}${locationStr}.</p>${detailsHtml}`,
  });
}

/** Send event updated notification. */
export async function sendEventUpdated(
  to: string,
  event: EventInfo,
  changes: string[],
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) return;

  const eventUrl = getEventLink(event);
  const translatedChanges = changes.map((c) => emailT(locale, `eventFields.${c}`));
  const changesStr = translatedChanges.join(", ");
  const viewDetails = emailT(locale, "eventUpdated.viewDetails");
  const wasUpdated = emailT(locale, "eventUpdated.wasUpdated");
  const detailsBlock = eventUrl ? `\n\n${viewDetails}: ${eventUrl}` : "";
  const detailsHtml = eventUrl ? `<p><a href="${eventUrl}">${viewDetails}</a></p>` : "";

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "eventUpdated.subject", { title: event.title }),
    text: `${event.title} ${wasUpdated} (${changesStr}).${detailsBlock}`,
    html: `<p><strong>${event.title}</strong> ${wasUpdated}: ${changesStr}.</p>${detailsHtml}`,
  });
}

/** Send event cancelled notification. */
export async function sendEventCancelled(
  to: string,
  event: EventInfo,
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) return;

  const hasBeenCancelled = emailT(locale, "eventCancelled.hasBeenCancelled");

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "eventCancelled.subject", { title: event.title }),
    text: `${event.title} ${hasBeenCancelled}`,
    html: `<p><strong>${event.title}</strong> ${hasBeenCancelled}</p>`,
  });
}
