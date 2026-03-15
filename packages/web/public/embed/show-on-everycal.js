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

  const LABELS = {
    en: {
      beforeWordmark: "Show on",
      afterWordmark: "",
      aria: "Show on EveryCal (opens in a new tab)",
    },
    de: {
      beforeWordmark: "Auf",
      afterWordmark: "anzeigen",
      aria: "Auf EveryCal anzeigen (oeffnet in einem neuen Tab)",
    },
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

  const BASE_CSS = `
    :host {
      display: inline-block;
      line-height: 1;
      font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
    }

    a {
      --ec-bg: #edf1f8;
      --ec-bg-hover: #dbe3f0;
      --ec-text: #152033;
      --ec-border: #c5cfdf;
      --ec-border-hover: #b45309;

      align-items: center;
      background: var(--ec-bg);
      border: 1px solid var(--ec-border);
      border-radius: 4px;
      color: var(--ec-text);
      cursor: pointer;
      display: inline-flex;
      font-weight: 620;
      gap: 0.4rem;
      letter-spacing: 0.01em;
      text-decoration: none;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
      white-space: nowrap;
    }

    a:hover {
      background: var(--ec-bg-hover);
      border-color: var(--ec-border-hover);
    }

    a:focus-visible {
      outline: 3px solid rgba(180, 83, 9, 0.35);
      outline-offset: 2px;
    }

    a[aria-disabled="true"] {
      cursor: not-allowed;
      opacity: 0.62;
      pointer-events: none;
    }

    .size-sm {
      font-size: 10px;
      min-height: 16px;
      padding: 0.24rem 0.48rem;
    }
    .size-sm .wordmark {
      height: 10px;
      transform: translateY(0.07em);
    }

    .size-md {
      font-size: 12px;
      min-height: 20px;
      padding: 0.3rem 0.58rem;
    }
    .size-md .wordmark {
      height: 12px;
      transform: translateY(0.07em);
    }

    .size-lg {
      font-size: 14px;
      min-height: 24px;
      padding: 0.36rem 0.68rem;
    }
    .size-lg .wordmark {
      height: 14px;
      transform: translateY(0.07em);
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
      line-height: 1;
      font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-weight: 600;
      gap: 0.32em;
    }

    .label-prefix,
    .label-suffix {
      display: inline-flex;
      align-items: center;
      line-height: 1;
    }

    .wordmark {
      display: block;
      width: auto;
      flex: 0 0 auto;
    }

    @media (prefers-reduced-motion: reduce) {
      a {
        transition: none;
      }
    }
  `;

  function resolveLanguage(explicitLang) {
    const direct = (explicitLang || "").trim();
    const page =
      (document.documentElement && document.documentElement.lang)
      || (navigator.language || "");
    const source = direct || page;
    const base = source.toLowerCase().split(/[-_]/)[0];
    return LABELS[base] ? base : "en";
  }

  function normalizeSize(value) {
    const candidate = (value || "md").toLowerCase();
    return SIZE_CLASS_MAP[candidate] || SIZE_CLASS_MAP.md;
  }

  function normalizeHref(value) {
    const trimmed = (value || "").trim();
    if (!trimmed) return null;

    try {
      const parsed = new URL(trimmed, ALLOWED_LINK_ORIGIN);
      const isAllowedOrigin = parsed.origin === ALLOWED_LINK_ORIGIN;
      const isProfileOrEventPath = /^\/@[^/?#]+(?:\/[^/?#]+)?\/?$/.test(parsed.pathname);
      const hasNoQueryOrHash = !parsed.search && !parsed.hash;
      if (isAllowedOrigin && isProfileOrEventPath && hasNoQueryOrHash) {
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
      return ["href", "size", "aria-label", "lang"];
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
      const lang = resolveLanguage(this.getAttribute("lang"));
      const labels = LABELS[lang] || LABELS.en;
      const wordmarkUrl = `${ALLOWED_LINK_ORIGIN}/embed/everycal-wordmark.svg`;
      const accessibleLabel =
        this.getAttribute("aria-label") || labels.aria;
      const safeHref = href ? escapeAttribute(href) : "";
      const safeLabel = escapeAttribute(accessibleLabel);
      const safeWordmarkUrl = escapeAttribute(wordmarkUrl);
      const safeBefore = escapeAttribute(labels.beforeWordmark || "");
      const safeAfter = escapeAttribute(labels.afterWordmark || "");
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
          <span class="label">
            ${safeBefore ? `<span class="label-prefix">${safeBefore}</span>` : ""}
            <img class="wordmark" src="${safeWordmarkUrl}" alt="EveryCal" />
            ${safeAfter ? `<span class="label-suffix">${safeAfter}</span>` : ""}
          </span>
        </a>
      `;
    }
  }

  window.customElements.define(TAG_NAME, EveryCalButton);
})();
