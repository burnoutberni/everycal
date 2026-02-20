/**
 * Security utilities — SSRF protection, input sanitization.
 */

import net from "node:net";
import dns from "node:dns/promises";
import sanitize from "sanitize-html";
import { SAFE_HTML_TAGS, SAFE_HTML_ATTRS, SAFE_HTML_SCHEMES } from "@everycal/core";

/**
 * Check if a hostname/IP belongs to a private, reserved, or internal network.
 * Used to prevent SSRF attacks.
 */
export function isPrivateIP(hostname: string): boolean {
  // Block common internal hostnames
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "0.0.0.0" ||
    lower === "[::1]" ||
    lower === "[::]" ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".localhost")
  ) {
    return true;
  }

  // If it's an IP address, check against private ranges
  if (net.isIPv4(hostname)) {
    return isPrivateIPv4(hostname);
  }

  // IPv6 — block loopback and link-local
  if (net.isIPv6(hostname) || hostname.startsWith("[")) {
    const clean = hostname.replace(/^\[|\]$/g, "");
    if (clean === "::1" || clean === "::" || clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) {
      return true;
    }
  }

  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;

  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (reserved)
  if (a >= 240) return true;

  return false;
}

/**
 * Strip all HTML tags and decode entities.
 * For fields that must be plain text (titles, display names, usernames, etc.).
 */
export function stripHtml(input: string): string {
  return sanitize(input, {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}

/**
 * Sanitize HTML content for safe rendering.
 * Allows only a safe subset of HTML tags and attributes.
 * Uses sanitize-html (DOM-aware) to prevent XSS including mutation attacks.
 * Used for rich-text fields like descriptions and bios.
 */
export function sanitizeHtml(input: string): string {
  return sanitize(input, {
    allowedTags: [...SAFE_HTML_TAGS],
    allowedAttributes: { ...SAFE_HTML_ATTRS },
    allowedSchemes: [...SAFE_HTML_SCHEMES],
    transformTags: {
      a: sanitize.simpleTransform("a", {
        rel: "nofollow noopener noreferrer",
        target: "_blank",
      }),
    },
    // Strip everything else including event handlers, javascript: URIs, etc.
  });
}

/**
 * Validate that a URL uses http or https scheme.
 * Returns true if valid, false otherwise.
 */
export function isValidHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Resolve a hostname via DNS and verify the resolved IP is not private/internal.
 * Prevents DNS rebinding attacks where a public hostname resolves to an internal IP.
 * Throws if the resolved IP is private.
 */
export async function assertPublicResolvedIP(hostname: string): Promise<void> {
  // If it's already an IP literal, isPrivateIP() handles it — skip DNS lookup
  if (net.isIPv4(hostname) || net.isIPv6(hostname) || hostname.startsWith("[")) {
    return;
  }

  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIPv4(address)) {
      throw new Error(`Hostname ${hostname} resolves to private IP ${address}`);
    }
    // Check IPv6 private ranges
    if (net.isIPv6(address)) {
      const clean = address.replace(/^\[|\]$/g, "");
      if (clean === "::1" || clean === "::" || clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) {
        throw new Error(`Hostname ${hostname} resolves to private IPv6 ${address}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Hostname")) throw err;
    // DNS lookup failure — let the fetch fail naturally
  }
}
