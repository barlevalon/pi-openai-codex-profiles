import { hasApi, isModelType } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { Api, Provider, ProviderAuth, ProviderRequestOptions, StreamOptions } from "@earendil-works/pi-ai";

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

function guardCallback<Args extends unknown[], Result>(guard: () => void, callback: (...args: Args) => Result, failed?: (error: unknown) => void) {
	return async (...args: Args): Promise<Awaited<Result>> => {
		try {
			guard();
			const result = await callback(...args);
			guard();
			return result;
		} catch (error) { failed?.(error); throw error; }
	};
}

export function protectRequest<M>(guard: () => void, options: ProviderRequestOptions<M> = {}, failed?: (error: unknown) => void): ProviderRequestOptions<M> {
	return {
		...options,
		fetch: guardCallback(guard, options.fetch ?? globalThis.fetch, failed),
		onPayload: guardCallback(guard, (payload, model) => options.onPayload?.(payload, model), failed),
		onResponse: guardCallback(guard, (response, model) => options.onResponse?.(response, model), failed),
	};
}

export function protectChat<O extends StreamOptions>(guard: () => void, options: O | undefined, failed?: (error: unknown) => void): O;
export function protectChat(guard: () => void, options: StreamOptions = {}, failed?: (error: unknown) => void): StreamOptions {
	return {
		...protectRequest(guard, options, failed),
		onProviderStreamEvent: guardCallback(guard, (event, model) => options.onProviderStreamEvent?.(event, model), failed),
	};
}
