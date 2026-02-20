import DOMPurify from "dompurify";
import { SAFE_HTML_TAGS, SAFE_HTML_ATTR_LIST } from "@everycal/core";

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...SAFE_HTML_TAGS],
    ALLOWED_ATTR: [...SAFE_HTML_ATTR_LIST],
  });
}
