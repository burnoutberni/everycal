const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return new Uint8Array();
    out[i] = byte;
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let mismatch = 0;
  for (let i = 0; i < aBytes.length; i += 1) mismatch |= aBytes[i] ^ bBytes[i];
  return mismatch === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: 100000,
    },
    keyMaterial,
    256
  );
  return `pbkdf2$100000$${toHex(salt.buffer)}$${toHex(bits)}`;
}

export async function verifyPassword(password: string, encodedHash: string | null): Promise<boolean> {
  if (!encodedHash) return false;
  const [algo, iterationsRaw, saltHex, hashHex] = encodedHash.split("$");
  if (algo !== "pbkdf2") return false;
  const iterations = Number.parseInt(iterationsRaw || "", 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromHex(saltHex || "");
  if (salt.length === 0) return false;

  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    256
  );

  return constantTimeEqual(toHex(bits), hashHex || "");
}
