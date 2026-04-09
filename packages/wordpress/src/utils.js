export function deriveServerMode(value) {
	const normalizedServerUrl = (value || "").trim();
	if (normalizedServerUrl.length === 0) {
		return "default";
	}

	return "custom";
}
