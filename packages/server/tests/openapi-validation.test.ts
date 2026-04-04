import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, validateOpenApiDoc, validateOpenApiDocument } from "../src/docs-openapi.js";

describe("OpenAPI validation", () => {
  it("passes semantic validation for the generated document", async () => {
    const result = await validateOpenApiDoc();
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("fails when a referenced component schema is missing", async () => {
    const broken = buildOpenApiDocument();
    delete broken.components.schemas.Error;

    const result = await validateOpenApiDocument(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes("Error"))).toBe(true);
  });

  it("fails when operationIds are duplicated", async () => {
    const broken = buildOpenApiDocument();
    broken.paths["/api/v1/bootstrap"].get.operationId = "healthz";

    const result = await validateOpenApiDocument(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes("duplicate operationId"))).toBe(true);
  });
});
