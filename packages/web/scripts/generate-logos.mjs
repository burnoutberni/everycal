#!/usr/bin/env node
/**
 * Generate PNG assets from logo SVGs.
 * Run: node scripts/generate-logos.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const iconSvg = readFileSync(join(publicDir, "icon.svg"));
const logoSvg = readFileSync(join(publicDir, "logo.svg"));

async function generate() {
  // Favicon sizes
  await sharp(iconSvg).resize(32, 32).png().toFile(join(publicDir, "favicon-32.png"));
  await sharp(iconSvg).resize(16, 16).png().toFile(join(publicDir, "favicon-16.png"));

  // Apple touch icon
  await sharp(iconSvg).resize(180, 180).png().toFile(join(publicDir, "apple-touch-icon.png"));

  // PWA icons
  await sharp(iconSvg).resize(192, 192).png().toFile(join(publicDir, "icon-192.png"));
  await sharp(iconSvg).resize(512, 512).png().toFile(join(publicDir, "icon-512.png"));

  // OG image (1200x630) — logo centered on warm gradient background
  const ogSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1a1a1a"/>
          <stop offset="100%" stop-color="#0d0d0d"/>
        </linearGradient>
        <linearGradient id="orb1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FBBF24"/>
          <stop offset="100%" stop-color="#F59E0B"/>
        </linearGradient>
        <linearGradient id="orb2" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#F59E0B"/>
          <stop offset="100%" stop-color="#FCD34D"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#bg)"/>
      <g transform="translate(500, 265)">
        <circle cx="60" cy="50" r="48" fill="url(#orb1)"/>
        <circle cx="120" cy="50" r="48" fill="url(#orb2)" fill-opacity="0.95"/>
      </g>
      <text x="600" y="420" text-anchor="middle" font-family="system-ui, sans-serif" font-size="72" font-weight="700" fill="#e0e0e0">EveryCal</text>
      <text x="600" y="480" text-anchor="middle" font-family="system-ui, sans-serif" font-size="28" fill="#888">Federated event calendar</text>
    </svg>
  `;
  await sharp(Buffer.from(ogSvg))
    .png()
    .toFile(join(publicDir, "og-image.png"));

  console.log("Generated: favicon-16.png, favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png, og-image.png");
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
