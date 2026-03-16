import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createEmbedCorpMiddleware } from "../src/middleware/embed-corp.js";

function createApp() {
  const app = new Hono();
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  app.use("*", createEmbedCorpMiddleware());

  app.get("/embed/show-on-everycal.js", (c) => c.text("window.customElements"));
  app.get("/embed/private.js", (c) => c.text("nope"));
  app.get("/api/v1/bootstrap", (c) => c.json({ ok: true }));

  return app;
}

describe("embed CORP middleware", () => {
  it("allows only the public embed script cross-origin", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/embed/show-on-everycal.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps non-embed routes on strict CORP", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/v1/bootstrap");

    expect(res.status).toBe(200);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not relax other embed paths", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/embed/private.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows HEAD requests to the public embed script", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/embed/show-on-everycal.js", {
      method: "HEAD",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
