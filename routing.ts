import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repoScope } from "./scope.ts";
import { quotaResponse, quotaUntil, type quotaStore, type QuotaKey } from "./quota.ts";

type Model = ReturnType<Provider["getModels"]>[number];
type Context = Parameters<Provider["streamSimple"]>[1];
type Options = NonNullable<Parameters<Provider["streamSimple"]>[2]>;
type Store = ReturnType<typeof quotaStore>;
export const PERSONAL = "openai-codex:personal";
export const WORK = "openai-codex:work";
export const REVIEW = "profile-review";
export const POLICY = "codex-policy";
const COPILOT = "github-copilot";

function hasOutput(message: AssistantMessage) {
	return message.content.length > 0 || Object.values(message.usage).some(value => typeof value === "number" && value > 0)
		|| Object.values(message.usage.cost).some(value => value > 0);
}

function rawHasOutput(value: unknown) {
	if (!value || typeof value !== "object") return false;
	const event = value as { usage?: Record<string, unknown>; response?: { usage?: Record<string, unknown>; output?: unknown[] }; message?: { usage?: Record<string, unknown>; content?: unknown[] } };
	return [event.usage, event.response?.usage, event.message?.usage].some(usage => usage && Object.values(usage).some(count => typeof count === "number" && count > 0))
		|| (event.response?.output?.length ?? 0) > 0 || (event.message?.content?.length ?? 0) > 0;
}

function failure(model: Model, error: unknown, aborted = false): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(),
		stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

export function routing(codex: Provider, copilot: Provider, current: () => ExtensionContext | undefined, quota: Store, notice: (message: string) => void) {
	function context() {
		const ctx = current();
		if (!ctx) throw new Error("Codex routing requires an active Pi session");
		return ctx;
	}
	function guardWork() {
		if (repoScope(current()?.cwd) !== "sibp") throw new Error("Work Codex is restricted to SIBP repositories");
	}
	function plan(review = false) {
		const codexPlan = repoScope(current()?.cwd) === "sibp" && quota.until("work-codex") <= Date.now() ? [WORK, PERSONAL] : [PERSONAL];
		return review && quota.until("copilot-review") <= Date.now() ? [COPILOT, ...codexPlan] : codexPlan;
	}
	function target(provider: string, id: string) {
		const model = context().modelRegistry.find(provider, id);
		if (!model) throw new Error(`Routing target is not registered: ${provider}/${id}`);
		return model;
	}
	function stream(source: Model, transcript: Context, options: Options = {}, simple = true, review = false) {
		const output = createAssistantMessageEventStream();
		let active = source;
		let partial: AssistantMessage | undefined;
		(async () => {
			if (source.provider === WORK) guardWork();
			const providers = plan(review);
			for (let index = 0; index < providers.length; index++) {
				options.signal?.throwIfAborted();
				const provider = providers[index];
				const id = review ? provider === COPILOT ? "claude-opus-5.5" : "gpt-6.1-sol" : source.id;
				const reuseInitial = index === 0 && provider === source.provider;
				active = reuseInitial ? source : target(provider, id);
				if (provider === WORK) guardWork();
				let requestOptions = options;
				if (!reuseInitial) {
					const { apiKey: _key, headers: _headers, env: _env, ...semantic } = options;
					const auth = await context().modelRegistry.getApiKeyAndHeaders(active);
					if (!auth.ok) throw new Error(auth.error);
					active = auth.baseUrl ? { ...active, baseUrl: auth.baseUrl } : active;
					requestOptions = { ...semantic, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
				}
				options.signal?.throwIfAborted();
				if (provider === WORK) guardWork();
				const key: QuotaKey | undefined = provider === WORK ? "work-codex" : provider === COPILOT ? "copilot-review" : undefined;
				partial = undefined;
				let state: "before-content" | "committed" | "terminal" = "before-content";
				let start: AssistantMessageEvent | undefined;
				let exhausted = false;
				let hookFailed = false;
				const local = new AbortController();
				const signal = options.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
				const observe = (until: number | undefined) => {
					if (!key || until === undefined) return;
					exhausted = true;
					quota.observe(key, until);
					if ((requestOptions.maxRetries ?? 0) > 0) local.abort();
				};
				const hooks = {
					...requestOptions,
					signal,
					maxRetries: requestOptions.maxRetries ?? 0,
					fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
						if (provider === WORK) guardWork();
						const response = await (requestOptions.fetch ?? globalThis.fetch)(input, init);
						if (key) observe(await quotaResponse(key, response, options.signal));
						return response;
					},
					onPayload: async (...args: Parameters<NonNullable<Options["onPayload"]>>) => {
						try {
							if (provider === WORK) guardWork();
							const value = await requestOptions.onPayload?.(...args);
							if (provider === WORK) guardWork();
							return value;
						} catch (error) { hookFailed = true; throw error; }
					},
					onResponse: async (...args: Parameters<NonNullable<Options["onResponse"]>>) => {
						try { await requestOptions.onResponse?.(...args); } catch (error) { hookFailed = true; throw error; }
					},
					onProviderStreamEvent: async (...args: Parameters<NonNullable<Options["onProviderStreamEvent"]>>) => {
						if (rawHasOutput(args[0])) state = "committed";
						if (key) observe(quotaUntil(key, args[0]));
						try { await requestOptions.onProviderStreamEvent?.(...args); } catch (error) { hookFailed = true; throw error; }
					},
				};
				const raw = provider === COPILOT ? copilot : codex;
				const inner = simple ? raw.streamSimple(active, transcript, hooks) : raw.stream(active, transcript, hooks);
				let terminal: AssistantMessageEvent | undefined;
				for await (const event of inner) {
					const snapshot = structuredClone(event);
					if ("partial" in snapshot) partial = snapshot.partial;
					if (snapshot.type === "done" || snapshot.type === "error") {
						terminal = snapshot;
						break;
					}
					if (snapshot.type === "start" && !hasOutput(snapshot.partial) && state === "before-content") {
						start = snapshot;
						continue;
					}
					state = "committed";
					if (start) { output.push(start); start = undefined; }
					output.push(snapshot);
				}
				if (!terminal) throw new Error("Provider stream ended without a terminal event");
				const message = terminal.type === "error" ? terminal.error : terminal.type === "done" ? terminal.message : undefined;
				if (terminal.type === "error" && message) {
					const emptyQuotaFailure = state === "before-content" && !hasOutput(message) && exhausted;
					const mayRetry = !hookFailed && !options.signal?.aborted && (terminal.reason !== "aborted" || local.signal.aborted);
					if (emptyQuotaFailure && mayRetry && index + 1 < providers.length) continue;
				}
				if (terminal.type === "error" && (options.signal?.aborted || local.signal.aborted)) {
					terminal.reason = options.signal?.aborted ? "aborted" : "error";
					terminal.error.stopReason = terminal.reason;
				}
				state = "terminal";
				if (start) output.push(start);
				if (review && provider !== COPILOT && (terminal.type === "done" || (message && hasOutput(message)))) notice("Review answered by Codex. Cross-family review diversity is reduced.");
				output.push(terminal);
				output.end();
				return;
			}
		})().catch(error => {
			const message = { ...partial, ...failure(active, error, options.signal?.aborted), ...(partial ? { content: partial.content, usage: partial.usage } : {}) };
			if (review && active.provider !== COPILOT && partial && hasOutput(partial)) notice("Review answered by Codex. Cross-family review diversity is reduced.");
			output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			output.end();
		});
		return output;
	}
	return { plan, target, guardWork, stream };
}
