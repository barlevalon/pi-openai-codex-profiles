import { hasApi, isModelType } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { Api, ClassifierOptions, Provider, ProviderAuth, StreamOptions } from "@earendil-works/pi-ai";

export function nativeProviders() {
	const providers = builtinProviders();
	const codex = providers.find((provider): provider is ReturnType<typeof openaiCodexProvider> => {
		if (provider.id !== "openai-codex") return false;
		const models = provider.getAllModels?.() ?? provider.getModels();
		return models.every(model => !isModelType(model, "chat") || hasApi(model, "openai-codex-responses"));
	});
	const copilot = providers.find((provider): provider is ReturnType<typeof githubCopilotProvider> => {
		if (provider.id !== "github-copilot") return false;
		const models = provider.getAllModels?.() ?? provider.getModels();
		return models.every(model => !isModelType(model, "chat") || hasApi(model, "anthropic-messages") || hasApi(model, "openai-completions") || hasApi(model, "openai-responses"));
	});
	if (!codex || !copilot) throw new Error("Required native providers are unavailable or have incompatible APIs");
	return { codex, copilot };
}

export function guardedAuth(auth: ProviderAuth, allowed: () => boolean, guard: () => void): ProviderAuth {
	const apiKey = auth.apiKey;
	const oauth = auth.oauth;
	return {
		...(apiKey ? { apiKey: {
			...apiKey,
			async check(input) {
				if (!allowed()) return undefined;
				let result;
				if (apiKey.check) result = await apiKey.check(input);
				else {
					const resolved = await apiKey.resolve(input);
					if (resolved) result = { type: "api_key" as const, source: resolved.source };
				}
				return allowed() ? result : undefined;
			},
			async resolve(input) {
				guard();
				const result = await apiKey.resolve(input);
				guard();
				return result;
			},
		} } : {}),
		...(oauth ? { oauth: {
			...oauth,
			refresh(credential, signal) {
				guard();
				// Native auth must persist a rotated token even if scope changes during refresh.
				return oauth.refresh(credential, signal);
			},
			async toAuth(credential) {
				guard();
				const result = await oauth.toAuth(credential);
				guard();
				return result;
			},
		} } : {}),
	};
}

export function guardedAvailability<A extends Api>(native: Provider<A>, allowed: () => boolean): Pick<Provider<A>, "filterModels" | "filterAllModels"> {
	return {
		filterModels(models, credential) {
			if (!allowed()) return [];
			return native.filterModels?.(models, credential) ?? models;
		},
		filterAllModels(models, credential) {
			if (!allowed()) return [];
			if (native.filterAllModels) return native.filterAllModels(models, credential);
			if (!native.filterModels) return models;
			const chatModels = models.filter(model => isModelType(model, "chat"));
			const available = new Set(native.filterModels(chatModels, credential).map(model => model.id));
			return models.filter(model => !isModelType(model, "chat") || available.has(model.id));
		},
	};
}

export function protectChat<O extends StreamOptions>(guard: () => void, options: O | undefined): O;
export function protectChat(guard: () => void, options: StreamOptions | undefined): StreamOptions {
	return {
		...options,
		async fetch(input, init) {
			guard();
			const response = await (options?.fetch ?? globalThis.fetch)(input, init);
			guard();
			return response;
		},
		async onPayload(payload, model) {
			guard();
			const result = await options?.onPayload?.(payload, model);
			guard();
			return result;
		},
		async onResponse(response, model) {
			guard();
			await options?.onResponse?.(response, model);
			guard();
		},
		async onProviderStreamEvent(event, model) {
			guard();
			await options?.onProviderStreamEvent?.(event, model);
			guard();
		},
	};
}

export function protectClassifier(guard: () => void, options: ClassifierOptions | undefined): ClassifierOptions {
	return {
		...options,
		async fetch(input, init) {
			guard();
			const response = await (options?.fetch ?? globalThis.fetch)(input, init);
			guard();
			return response;
		},
		async onPayload(payload, model) {
			guard();
			const result = await options?.onPayload?.(payload, model);
			guard();
			return result;
		},
		async onResponse(response, model) {
			guard();
			await options?.onResponse?.(response, model);
			guard();
		},
	};
}
