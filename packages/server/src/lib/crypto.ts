/**
 * RSA key pair generation and HTTP Signature utilities for ActivityPub.
 */

import crypto from "node:crypto";

/** Generate an RSA key pair (2048-bit) for ActivityPub signing. */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return { publicKey, privateKey };
}

/**
 * Sign an HTTP request with HTTP Signatures (draft-cavage-http-signatures).
 *
 * Returns headers dict with Signature and Date headers set.
 */
export function signRequest(
  method: string,
  url: string,
  body: string | null,
  privateKeyPem: string,
  keyId: string
): Record<string, string> {
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const digest = body
    ? `SHA-256=${crypto.createHash("sha256").update(body).digest("base64")}`
    : undefined;

  const headers: Record<string, string> = {
    Host: parsedUrl.host,
    Date: date,
    "Content-Type": "application/activity+json",
  };

  if (digest) {
    headers["Digest"] = digest;
  }

  // Build the signing string
  const signedHeaders = ["(request-target)", "host", "date"];
  if (digest) signedHeaders.push("digest");

  const signingParts = signedHeaders.map((h) => {
    if (h === "(request-target)") {
      return `(request-target): ${method.toLowerCase()} ${parsedUrl.pathname}`;
    }
    // Map lowercase header names to the actual header keys
    const headerMap: Record<string, string> = {
      host: "Host",
      date: "Date",
      digest: "Digest",
      "content-type": "Content-Type",
    };
    const key = headerMap[h] || h;
    return `${h}: ${headers[key]}`;
  });
  const signingString = signingParts.join("\n");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingString);
  const signature = sign.sign(privateKeyPem, "base64");

  headers[
    "Signature"
  ] = `keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaders.join(" ")}",signature="${signature}"`;

  return headers;
}

/**
 * Verify an HTTP Signature on an incoming request.
 */
export function verifySignature(
  method: string,
  path: string,
  headers: Record<string, string>,
  publicKeyPem: string
): boolean {
  const sigHeader = headers["signature"];
  if (!sigHeader) return false;

  const parts = parseSignatureHeader(sigHeader);
  if (!parts.headers || !parts.signature) return false;

  const signedHeaders = parts.headers.split(" ");
  const signingParts = signedHeaders.map((h: string) => {
    if (h === "(request-target)") {
      return `(request-target): ${method.toLowerCase()} ${path}`;
    }
    // Try lowercase and various cases
    const val = headers[h] || headers[h.toLowerCase()];
    return `${h}: ${val}`;
  });
  const signingString = signingParts.join("\n");

  try {
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(signingString);
    return verify.verify(publicKeyPem, parts.signature, "base64");
  } catch {
    return false;
  }
}

function parseSignatureHeader(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}
