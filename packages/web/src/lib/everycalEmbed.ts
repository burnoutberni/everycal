const EMBEDDABLE_PATH_RE = /^\/@[^/?#]+(?:\/[^/?#]+)?\/?$/;

export function normalizeEmbeddableEverycalPath(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const pathOnly = trimmed.split(/[?#]/, 1)[0] || "";
  if (!EMBEDDABLE_PATH_RE.test(pathOnly)) return null;
  return pathOnly;
}

export function buildShowOnEverycalEmbedCode(path: string, origin: string): string {
  const normalizedPath = normalizeEmbeddableEverycalPath(path);
  if (!normalizedPath) return "";
  const scriptUrl = new URL("/embed/show-on-everycal.js", origin).toString();
  const hrefUrl = new URL(normalizedPath, origin).toString();
  return `<script src="${scriptUrl}" defer></script>\n<everycal-button href="${hrefUrl}" size="md"></everycal-button>`;
}
