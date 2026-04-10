export function deriveServerMode(value) {
	const normalizedServerUrl = (value || "").trim();
	if (normalizedServerUrl.length === 0) {
		return "default";
	}

	return "custom";
}

export function createInstanceId(seed) {
	const normalizedSeed = (seed || "")
		.toString()
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");

	if (normalizedSeed.length > 0) {
		return `ec${normalizedSeed.slice(0, 16)}`;
	}

	const randomSuffix = Math.random().toString(36).slice(2, 12);
	return `ec${randomSuffix}`;
}
