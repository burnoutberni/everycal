// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const embedSource = readFileSync(
  join(process.cwd(), "public/embed/show-on-everycal.js"),
  "utf8",
);

function defineEmbedComponent() {
  window.eval(embedSource);
}

function createButton(href?: string, size?: string) {
  const button = document.createElement("everycal-button");
  if (href !== undefined) button.setAttribute("href", href);
  if (size !== undefined) button.setAttribute("size", size);
  document.body.appendChild(button);

  const anchor = button.shadowRoot?.querySelector("a");
  if (!anchor) {
    throw new Error("expected anchor element in everycal-button shadow root");
  }

  return { button, anchor };
}

describe("show-on-everycal embed component", () => {
  beforeAll(() => {
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      value: { src: "https://everycal.example/embed/show-on-everycal.js" },
    });

    defineEmbedComponent();

    Object.defineProperty(document, "currentScript", {
      configurable: true,
      value: null,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses medium size by default", () => {
    const { anchor } = createButton("/@alice");

    expect(anchor.classList.contains("size-md")).toBe(true);
  });

  it("enables profile and event paths on the allowed domain", () => {
    const profile = createButton("/@alice").anchor;
    const event = createButton("/@bob/launch-party").anchor;
    const absolute = createButton("https://everycal.example/@carol").anchor;

    expect(profile.getAttribute("href")).toBe("https://everycal.example/@alice");
    expect(event.getAttribute("href")).toBe(
      "https://everycal.example/@bob/launch-party",
    );
    expect(absolute.getAttribute("href")).toBe("https://everycal.example/@carol");
    expect(profile.getAttribute("aria-disabled")).toBe("false");
    expect(event.getAttribute("aria-disabled")).toBe("false");
    expect(absolute.getAttribute("aria-disabled")).toBe("false");
  });

  it("disables invalid href values", () => {
    const invalidPath = createButton("/calendar").anchor;
    const foreignDomain = createButton("https://evil.example/@alice").anchor;
    const withQuery = createButton("/@alice?view=list").anchor;
    const withHash = createButton("/@alice#section").anchor;
    const missing = createButton().anchor;

    for (const anchor of [
      invalidPath,
      foreignDomain,
      withQuery,
      withHash,
      missing,
    ]) {
      expect(anchor.hasAttribute("href")).toBe(false);
      expect(anchor.getAttribute("aria-disabled")).toBe("true");
      expect(anchor.getAttribute("tabindex")).toBe("-1");
    }
  });
});
