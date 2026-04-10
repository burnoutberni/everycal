import { createInstanceId, deriveServerMode } from "./utils";

describe("deriveServerMode", () => {
	it("returns default for an empty string", () => {
		expect(deriveServerMode("")).toBe("default");
	});

	it("returns default for whitespace-only strings", () => {
		expect(deriveServerMode("   ")).toBe("default");
	});

	it("returns custom for non-empty values", () => {
		expect(deriveServerMode("https://events.example.com")).toBe("custom");
	});
});

describe("createInstanceId", () => {
	it("creates a deterministic id from a seed", () => {
		expect(createInstanceId("4f8e17af-5f90-4d4a-87b6-955d3d5cf8bd")).toBe(
			"ec4f8e17af5f904d4a"
		);
	});

	it("falls back to a random id when seed is missing", () => {
		const result = createInstanceId();
		expect(result).toMatch(/^ec[a-z0-9]{10}$/);
	});
});
