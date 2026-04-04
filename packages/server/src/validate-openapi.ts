import { validateOpenApiDoc } from "./docs-openapi.js";

const result = await validateOpenApiDoc();
if (!result.ok) {
  for (const issue of result.issues) console.error(`OpenAPI validation error: ${issue}`);
  process.exit(1);
}
console.log("OpenAPI semantic validation passed.");
