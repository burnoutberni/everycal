(() => {
  const TAG_NAME = "everycal-button";

  if (!window.customElements || window.customElements.get(TAG_NAME)) {
    return;
  }

  const SIZE_CLASS_MAP = {
    sm: "size-sm",
    md: "size-md",
    lg: "size-lg",
  };

  const ALLOWED_LINK_ORIGIN = (() => {
    const scriptSrc = document.currentScript && document.currentScript.src;
    if (scriptSrc) {
      try {
        return new URL(scriptSrc).origin;
      } catch {
        return window.location.origin;
      }
    }
    return window.location.origin;
  })();

  const ALLOWED_LINK_DOMAIN = new URL(ALLOWED_LINK_ORIGIN).hostname.toLowerCase();

  const BASE_CSS = `
    :host {
      display: inline-block;
      line-height: 1;
      font-family: "Bricolage Grotesque Variable", "Avenir Next", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    }

    a {
      --ec-bg: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      --ec-bg-hover: linear-gradient(135deg, #f6aa2a 0%, #c46508 100%);
      --ec-text: #ffffff;
      --ec-border: rgba(95, 48, 7, 0.35);
      --ec-shadow: 0 8px 20px rgba(132, 64, 8, 0.26);
      --ec-shadow-hover: 0 10px 24px rgba(132, 64, 8, 0.32);

      align-items: center;
      background: var(--ec-bg);
      border: 1px solid var(--ec-border);
      border-radius: 999px;
      box-shadow: var(--ec-shadow);
      color: var(--ec-text);
      cursor: pointer;
      display: inline-flex;
      font-weight: 670;
      gap: 0.48rem;
      letter-spacing: 0.01em;
      overflow: hidden;
      position: relative;
      text-decoration: none;
      transform: translateY(0);
      transition: transform 180ms ease, box-shadow 180ms ease, background 180ms ease;
      white-space: nowrap;
    }

    a::after {
      background: linear-gradient(105deg, rgba(255, 255, 255, 0) 30%, rgba(255, 255, 255, 0.38) 48%, rgba(255, 255, 255, 0) 68%);
      content: "";
      inset: 0;
      opacity: 0;
      position: absolute;
      transform: translateX(-125%);
      transition: transform 320ms ease, opacity 200ms ease;
    }

    a:hover {
      background: var(--ec-bg-hover);
      box-shadow: var(--ec-shadow-hover);
      transform: translateY(-1px);
    }

    a:hover::after {
      opacity: 1;
      transform: translateX(125%);
    }

    a:active {
      transform: translateY(0);
    }

    a:focus-visible {
      outline: 3px solid rgba(245, 158, 11, 0.45);
      outline-offset: 3px;
    }

    a[aria-disabled="true"] {
      cursor: not-allowed;
      opacity: 0.62;
      pointer-events: none;
      transform: none;
    }

    .size-sm {
      font-size: 12px;
      min-height: 34px;
      padding: 0.45rem 0.72rem;
    }

    .size-md {
      font-size: 14px;
      min-height: 40px;
      padding: 0.58rem 0.92rem;
    }

    .size-lg {
      font-size: 15px;
      min-height: 46px;
      padding: 0.72rem 1.04rem;
    }

    .icon {
      align-items: center;
      display: inline-flex;
      flex: 0 0 auto;
      justify-content: center;
      width: 1.32em;
      height: 1.32em;
    }

    .icon svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .label {
      align-items: center;
      display: inline-flex;
      line-height: 1.08;
      position: relative;
      top: 0.02em;
    }

    @media (max-width: 480px) {
      .size-md,
      .size-lg {
        font-size: 14px;
        min-height: 44px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      a,
      a::after {
        transition: none;
      }

      a:hover,
      a:active {
        transform: none;
      }

      a:hover::after {
        opacity: 0;
        transform: none;
      }
    }
  `;

  function normalizeSize(value) {
    const candidate = (value || "md").toLowerCase();
    return SIZE_CLASS_MAP[candidate] || SIZE_CLASS_MAP.md;
  }

  function normalizeHref(value) {
    const trimmed = (value || "").trim();
    if (!trimmed) return null;

    try {
      const parsed = new URL(trimmed, ALLOWED_LINK_ORIGIN);
      const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
      const isAllowedDomain = parsed.hostname.toLowerCase() === ALLOWED_LINK_DOMAIN;
      const isProfileOrEventPath = /^\/@[^/?#]+(?:\/[^/?#]+)?\/?$/.test(parsed.pathname);
      const hasNoQueryOrHash = !parsed.search && !parsed.hash;
      if (isHttp && isAllowedDomain && isProfileOrEventPath && hasNoQueryOrHash) {
        return parsed.toString();
      }
      return null;
    } catch {
      return null;
    }
  }

  function escapeAttribute(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  class EveryCalButton extends HTMLElement {
    static get observedAttributes() {
      return ["href", "size", "aria-label"];
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    connectedCallback() {
      this.render();
    }

    attributeChangedCallback() {
      this.render();
    }

    render() {
      if (!this.shadowRoot) return;

      const href = normalizeHref(this.getAttribute("href"));
      const sizeClass = normalizeSize(this.getAttribute("size"));
      const accessibleLabel =
        this.getAttribute("aria-label") || "Show on EveryCal (opens in a new tab)";
      const safeHref = href ? escapeAttribute(href) : "";
      const safeLabel = escapeAttribute(accessibleLabel);
      const linkStateAttributes = href
        ? `href="${safeHref}" target="_blank" rel="noopener noreferrer external" aria-disabled="false"`
        : `aria-disabled="true" tabindex="-1"`;

      this.shadowRoot.innerHTML = `
        <style>${BASE_CSS}</style>
        <a
          class="${sizeClass}"
          ${linkStateAttributes}
          aria-label="${safeLabel}"
        >
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
              <circle cx="12" cy="16" r="10" fill="#F59E0B" />
              <circle cx="20" cy="16" r="10" fill="#FCD34D" fill-opacity="0.9" />
            </svg>
          </span>
          <span class="label">Show on EveryCal</span>
        </a>
      `;
    }
  }

  window.customElements.define(TAG_NAME, EveryCalButton);
})();
