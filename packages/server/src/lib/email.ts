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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  slug: string;
  account: { username: string; domain?: string | null };
  startDate: string;
  endDate?: string | null;
  allDay?: boolean;
  location?: { name?: string } | null;
  url?: string | null;
}

export interface EventChange {
  field: "title" | "time" | "location";
  before?: string | null;
  after?: string | null;
}

/** Build event link for emails. Prefer canonical page path /@user/event-slug for both local and remote events. */
function getEventLink(event: EventInfo): string {
  const hasExplicitDomain = !!event.account.domain;
  const username = hasExplicitDomain && event.account.username.includes("@")
    ? event.account.username.split("@")[0]
    : event.account.username;
  const domainPart = hasExplicitDomain ? `@${event.account.domain}` : "";
  return `${baseUrl()}/@${username}${domainPart}/${event.slug}`;
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
  const detailsHtml = eventUrl
    ? `<p><a href="${escapeHtml(eventUrl)}">${escapeHtml(viewDetails)}</a></p>`
    : "";

  const subject =
    hoursAhead === 1
      ? emailT(locale, "reminder.subject_one", { title: event.title })
      : emailT(locale, "reminder.subject", { title: event.title, hours: String(hoursAhead) });

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text: `${event.title} ${starts} ${timeStr}${locationStr}.${detailsBlock}`,
    html: `<p><strong>${escapeHtml(event.title)}</strong> ${escapeHtml(starts)} ${escapeHtml(timeStr + locationStr)}.</p>${detailsHtml}`,
  });
}

/** Send event updated notification. */
export async function sendEventUpdated(
  to: string,
  event: EventInfo,
  changes: EventChange[],
  locale = "en"
): Promise<void> {
  const transport = getTransporter();
  if (!transport) return;

  const eventUrl = getEventLink(event);
  const translatedChanges = changes
    .map((c) => {
      const field = emailT(locale, `eventFields.${c.field}`);
      const before = c.before?.trim() || "";
      const after = c.after?.trim() || "";
      if (before && after) return `${field}: "${before}" → "${after}"`;
      if (after) return `${field}: ${after}`;
      if (before) return `${field}: ${before}`;
      return field;
    })
    .join("\n- ");
  const viewDetails = emailT(locale, "eventUpdated.viewDetails");
  const wasUpdated = emailT(locale, "eventUpdated.changes");
  const detailsBlock = eventUrl ? `\n\n${viewDetails}: ${eventUrl}` : "";
  const detailsHtml = eventUrl
    ? `<p><a href="${escapeHtml(eventUrl)}">${escapeHtml(viewDetails)}</a></p>`
    : "";

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "eventUpdated.subject", { title: event.title }),
    text: `${event.title}\n\n${wasUpdated}:\n- ${translatedChanges}${detailsBlock}`,
    html: `<p><strong>${escapeHtml(event.title)}</strong></p><p>${escapeHtml(wasUpdated)}:</p><ul>${changes
      .map((c) => {
        const field = escapeHtml(emailT(locale, `eventFields.${c.field}`));
        const before = escapeHtml((c.before || "").trim());
        const after = escapeHtml((c.after || "").trim());
        if (before && after) return `<li><strong>${field}</strong>: &quot;${before}&quot; → &quot;${after}&quot;</li>`;
        if (after) return `<li><strong>${field}</strong>: ${after}</li>`;
        if (before) return `<li><strong>${field}</strong>: ${before}</li>`;
        return `<li><strong>${field}</strong></li>`;
      })
      .join("")}</ul>${detailsHtml}`,
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
  const viewDetails = emailT(locale, "eventUpdated.viewDetails");
  const eventUrl = getEventLink(event);

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: emailT(locale, "eventCancelled.subject", { title: event.title }),
    text: `${event.title} ${hasBeenCancelled}

${viewDetails}: ${eventUrl}`,
    html: `<p><strong>${escapeHtml(event.title)}</strong> ${escapeHtml(hasBeenCancelled)}</p><p><a href="${escapeHtml(eventUrl)}">${escapeHtml(viewDetails)}</a></p>`,
  });
}
