export function asciiAlphanumeric(character: string): boolean {
	return character.length === 1 && (
		character >= "A" && character <= "Z" ||
		character >= "a" && character <= "z" ||
		character >= "0" && character <= "9"
	);
}

export function unpaddedText(value: string): boolean {
	if (!value || value !== value.trim()) return false;
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127) return false;
	}
	return true;
}

export function githubOwner(value: string): boolean {
	if (value.length < 1 || value.length > 39) return false;
	return value.split("-").every(segment => segment.length > 0 && [...segment].every(asciiAlphanumeric));
}
