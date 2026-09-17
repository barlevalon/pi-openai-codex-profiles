import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROFILES = ["personal", "work"] as const;

function createProfileProvider(profile: (typeof PROFILES)[number]): Provider<"openai-codex-responses"> {
	const provider = builtinProviders().find(({ id }) => id === "openai-codex")!;
	const id = `${provider.id}:${profile}`;
	const models = provider.getModels().map((model) => ({ ...model, provider: id }));

	return {
		...provider,
		id,
		name: `${provider.name} (${profile})`,
		getModels: () => models,
	};
}

export default function (pi: ExtensionAPI) {
	for (const profile of PROFILES) {
		pi.registerProvider(createProfileProvider(profile));
	}
}
