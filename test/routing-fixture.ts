import assert from "node:assert/strict";
import { createNativeRouting } from "../routing.ts";

export function routingFixture(...args: Parameters<typeof createNativeRouting>) {
	const routing = createNativeRouting(...args);
	function provider(id: string) {
		const result = routing.providers.find(provider => provider.id === id);
		assert.ok(result, `Missing guarded provider ${id}`);
		return result;
	}
	return {
		...routing,
		personal: provider("openai-codex:personal"),
		work: provider("openai-codex:work"),
		copilot: provider("github-copilot"),
		review: provider("profile-review"),
		unavailableReview: routing.selections.find(selection => selection.provider === "profile-review"),
	};
}
