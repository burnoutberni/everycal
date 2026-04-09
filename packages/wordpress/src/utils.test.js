import { deriveServerMode } from "./utils";

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
