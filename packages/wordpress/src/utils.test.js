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
	const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"crypto"
	);

	afterEach(() => {
		jest.restoreAllMocks();

		if (originalCryptoDescriptor) {
			Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
		}
	});

	it("creates a deterministic id from a seed", () => {
		expect(createInstanceId("4f8e17af-5f90-4d4a-87b6-955d3d5cf8bd")).toBe(
			"ec4f8e17af5f904d4a"
		);
	});

	it("uses crypto.randomUUID when available", () => {
		jest
			.spyOn(globalThis.crypto, "randomUUID")
			.mockReturnValue("12345678-90ab-cdef-1234-567890abcdef");

		const result = createInstanceId();
		expect(result).toBe("ec1234567890");
	});

	it("falls back to a fixed-length random id when crypto is missing", () => {
		Object.defineProperty(globalThis, "crypto", {
			value: undefined,
			configurable: true,
		});
		jest.spyOn(Math, "random").mockReturnValue(0.5);

		const result = createInstanceId();

		expect(result).toBe("eciiiiiiiiii");
		expect(result).toMatch(/^ec[a-z0-9]{10}$/);
	});
});
