/**
 * Email sending via SMTP (nodemailer).
 * Fails gracefully if SMTP is not configured.
 */

import nodemailer from "nodemailer";
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
export async function sendVerificationEmail(to: string, token: string): Promise<void> {
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
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: "Verify your EveryCal account",
    text: `Click the link below to verify your account:\n\n${url}\n\nThe link expires in 24 hours.`,
    html: `<p>Click the link below to verify your account:</p><p><a href="${url}">${url}</a></p><p>The link expires in 24 hours.</p>`,
  });
}

/** Send welcome email after verification. */
export async function sendWelcomeEmail(to: string, username: string): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.SKIP_EMAIL_VERIFICATION === "true") {
      console.log(`[dev] Welcome email skipped (SMTP not configured)`);
      return;
    }
    return;
  }

  const url = baseUrl();
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: "Welcome to EveryCal",
    text: `Welcome to EveryCal, ${username}!\n\nGet started at ${url}`,
    html: `<p>Welcome to EveryCal, ${username}!</p><p><a href="${url}">Get started</a></p>`,
  });
}

/** Send email change verification (add or change email on existing account). */
export async function sendEmailChangeVerificationEmail(to: string, token: string): Promise<void> {
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
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: "Verify your new email address",
    text: `Click the link below to verify your new email address:\n\n${url}\n\nThe link expires in 24 hours.`,
    html: `<p>Click the link below to verify your new email address:</p><p><a href="${url}">${url}</a></p><p>The link expires in 24 hours.</p>`,
  });
}

/** Send password reset email. */
export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
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
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: "Reset your EveryCal password",
    text: `Click the link below to reset your password:\n\n${url}\n\nThe link expires in 1 hour.`,
    html: `<p>Click the link below to reset your password:</p><p><a href="${url}">${url}</a></p><p>The link expires in 1 hour.</p>`,
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
  hoursAhead: number
): Promise<void> {
  const transport = getTransporter();
  if (!transport) return;

  const eventUrl = getEventLink(event);
  const timeStr = event.allDay
    ? new Date(event.startDate).toLocaleDateString()
    : new Date(event.startDate).toLocaleString();
  const locationStr = event.location?.name ? ` at ${event.location.name}` : "";
  const detailsBlock = eventUrl
    ? `\n\nView details: ${eventUrl}`
    : "";
  const detailsHtml = eventUrl
    ? `<p><a href="${eventUrl}">View details</a></p>`
    : "";

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `Reminder: ${event.title} in ${hoursAhead} hour${hoursAhead === 1 ? "" : "s"}`,
    text: `${event.title} starts ${timeStr}${locationStr}.${detailsBlock}`,
    html: `<p><strong>${event.title}</strong> starts ${timeStr}${locationStr}.</p>${detailsHtml}`,
  });
}

/** Send event updated notification. */
export async function sendEventUpdated(
  to: string,
  event: EventInfo,
  changes: string[]
): Promise<void> {
  const transport = getTransporter();
  if (!transport) return;

  const eventUrl = getEventLink(event);
  const changesStr = changes.join(", ");
  const detailsBlock = eventUrl ? `\n\nView details: ${eventUrl}` : "";
  const detailsHtml = eventUrl ? `<p><a href="${eventUrl}">View details</a></p>` : "";

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `Updated: ${event.title}`,
    text: `${event.title} was updated (${changesStr}).${detailsBlock}`,
    html: `<p><strong>${event.title}</strong> was updated: ${changesStr}.</p>${detailsHtml}`,
  });
}

/** Send event cancelled notification. */
export async function sendEventCancelled(to: string, event: EventInfo): Promise<void> {
  const transport = getTransporter();
  if (!transport) return;

  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `Cancelled: ${event.title}`,
    text: `${event.title} has been cancelled.`,
    html: `<p><strong>${event.title}</strong> has been cancelled.</p>`,
  });
}
