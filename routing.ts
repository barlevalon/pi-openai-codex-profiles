import { createAssistantMessageEventStream, getSupportedThinkingLevels, hasApi } from "@earendil-works/pi-ai";
import type { Api, ApiStreamOptions, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider, SimpleStreamOptions, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repoScope, type RepoScope } from "./scope.ts";
import type { Policy } from "./policy.ts";
import { reviewModel } from "./review.ts";
import type { QuotaLedger } from "./quota.ts";
import { decodeQuotaPayload, decodeQuotaResponse, type DirectObservation } from "./quota-protocol.ts";
import { guardedAuth, guardedAvailability, protectChat, protectRequest } from "./native-guards.ts";
import { failure, hasOutput, rawHasOutput } from "./stream-evidence.ts";
import { COPILOT_ACCOUNT, PERSONAL_ACCOUNT, WORK_ACCOUNT, accountEligible, accountOwner, codexModelId, eligibleCandidates, selectTargets } from "./targets.ts";
import type { Candidates, CodexAccount, ModelTarget, ProviderAccount } from "./targets.ts";

type CodexApi = ReturnType<typeof openaiCodexProvider> extends Provider<infer A> ? A : never;
type CopilotApi = ReturnType<typeof githubCopilotProvider> extends Provider<infer A> ? A : never;
type VirtualModel = Parameters<ExtensionAPI["registerVirtualModel"]>[0];
type Terminal = Extract<AssistantMessageEvent, { type: "done" | "error" }>;
type Start = Extract<AssistantMessageEvent, { type: "start" }>;
type Progress = Readonly<{ kind: "hidden" }> | Readonly<{ kind: "hidden-quota" }>
	| Readonly<{ kind: "committed" }> | Readonly<{ kind: "blocked"; cause: unknown }>;
type Outcome = Readonly<{ kind: "answered"; terminal: Extract<Terminal, { type: "done" }>; start?: Start }>
	| Readonly<{ kind: "stopped"; terminal: Extract<Terminal, { type: "error" }>; start?: Start }>
	| Readonly<{ kind: "quota-before-output"; terminal: Extract<Terminal, { type: "error" }>; start?: Start }>;

export const PERSONAL = PERSONAL_ACCOUNT.credential;
export const WORK = WORK_ACCOUNT.credential;
export const REVIEW = "profile-review";
export const POLICY = "codex-policy";
export const REVIEW_NOTICE = "Routing notice. This review used the configured Codex fallback after Copilot quota exhaustion.";

function codexSource(model: Model<Api>): Model<CodexApi> {
	if (!hasApi(model, "openai-codex-responses")) throw new Error("Invalid Codex model API");
	return model;
}

function copilotSource(model: Model<Api>): Model<CopilotApi> {
	if (hasApi(model, "anthropic-messages") || hasApi(model, "openai-completions") || hasApi(model, "openai-responses")) return model;
	throw new Error("Invalid Copilot model API");
}

export function createNativeRouting(
	codex: Provider<CodexApi>,
	copilot: Provider<CopilotApi>,
	current: () => ExtensionContext | undefined,
	quota: QuotaLedger,
	notice: (message: string) => void,
	policy: Policy,
	bootstrapCwd: () => string | undefined = () => undefined,
) {
	function context() {
		const ctx = current();
		if (!ctx) throw new Error("Codex routing requires an active Pi session");
		return ctx;
	}
	function scopeFor(cwd: string | undefined) {
		const work = policy.profiles.find(profile => profile.name === "work");
		return work ? repoScope(cwd, work.criteria) : "unknown";
	}
	function scope() { return scopeFor(current()?.cwd); }
	function discoveryScope() { return scopeFor(current()?.cwd ?? bootstrapCwd()); }
	function discoverable(account: ProviderAccount) { return accountEligible(policy, account, discoveryScope()); }
	function allowed(account: ProviderAccount, repository = accountOwner(policy, account)?.name === "work" ? scope() : "unknown") {
		return accountEligible(policy, account, repository);
	}
	function requireAccount(account: ProviderAccount, repository?: RepoScope) {
		if (!allowed(account, repository)) throw new Error(`${account.credential} is restricted to its configured eligible profile repositories`);
	}
	function requestGuard(account: ProviderAccount, repository = scope(), cwd = current()?.cwd) {
		requireAccount(account, repository);
		const restricted = accountOwner(policy, account)?.name === "work";
		return () => {
			if (restricted && current()?.cwd !== cwd) throw new Error("Repository changed during the request");
		};
	}
	function physical(target: ModelTarget): Model<Api> {
		const model = context().modelRegistry.find(target.account.credential, target.modelId);
		if (!model) throw new Error("Configured routing target is not registered");
		return target.account.credential === COPILOT_ACCOUNT.credential ? copilotSource(model) : codexSource(model);
	}
	function candidates(intent: Parameters<typeof eligibleCandidates>[2], repository: RepoScope): Candidates {
		const eligibility = eligibleCandidates(policy, repository, intent);
		if (eligibility.kind === "unavailable") throw new Error(`Routing is unavailable for this profile: ${eligibility.reason}`);
		return selectAvailable(eligibility.targets);
	}
	function selectAvailable(targets: Candidates): Candidates {
		const selection = selectTargets(targets, quota.snapshot(targets, Date.now()));
		if (selection.kind === "unavailable") {
			if (selection.reason === "budget-unreadable") throw new Error("Cannot read configured routing quota state");
			throw new Error("All configured routing targets are cooling down");
		}
		return selection.targets;
	}
	const derivedReview = reviewModel(policy.review,
		copilot.getModels().find(model => model.id === policy.review?.primary),
		codex.getModels().find(model => model.id === policy.review?.fallback));
	const reviewModels = derivedReview ? [derivedReview] : [];
	function reviewTargets(repository: RepoScope, selected?: Model<Api>): Candidates | undefined {
		const registry = current()?.modelRegistry;
		if (!derivedReview || !registry) return;
		const advertised = selected ?? registry.find(REVIEW, derivedReview.id);
		if (!advertised || advertised.id !== derivedReview.id) return;
		const eligibility = eligibleCandidates(policy, repository, { kind: "review" });
		if (eligibility.kind !== "eligible") return;
		const primary = registry.find(COPILOT_ACCOUNT.credential, derivedReview.id);
		for (const target of eligibility.targets) {
			if (target.account.credential === COPILOT_ACCOUNT.credential) continue;
			const fallback = registry.find(target.account.credential, target.modelId);
			if (!fallback || !hasApi(fallback, "openai-codex-responses") || !reviewModel(policy.review, primary, fallback, advertised)) return;
		}
		return eligibility.targets;
	}
	function requireReview(repository: RepoScope, selected?: Model<Api>): Candidates {
		const targets = reviewTargets(repository, selected);
		if (!targets) throw new Error("Configured review targets are unavailable or have incompatible capabilities for this profile");
		return targets;
	}
	function reviewAllowed() {
		if (!derivedReview) return false;
		if (!current()) return accountEligible(policy, COPILOT_ACCOUNT, discoveryScope());
		return reviewTargets(scope()) !== undefined;
	}

	function openStream<A extends Api, O extends StreamOptions>(
		source: Model<A>,
		options: O,
		prepare: (repository: RepoScope) => Candidates,
		destination: (target: ModelTarget) => Model<A>,
		native: (target: ModelTarget, model: Model<A>, hooks: O) => AssistantMessageEventStream,
	) {
		const output = createAssistantMessageEventStream();
		const cwd = current()?.cwd;
		const repository = scope();
		async function consume(target: ModelTarget, reuse: boolean): Promise<Outcome> {
			const attempt: { progress: Progress } = { progress: { kind: "hidden" } };
			const quotaAbort = new AbortController();
			let active: Model<A> = source;
			let partial: AssistantMessage | undefined;
			let start: Start | undefined;
			let terminal: Terminal | undefined;
			function block(cause: unknown) {
				if (attempt.progress.kind !== "blocked") attempt.progress = { kind: "blocked", cause };
			}
			function commit() {
				if (attempt.progress.kind === "hidden" || attempt.progress.kind === "hidden-quota") attempt.progress = { kind: "committed" };
			}
			function observe(observation: DirectObservation | undefined) {
				if (!observation) return;
				quota.observeDirect(observation);
				if (attempt.progress.kind === "hidden") attempt.progress = { kind: "hidden-quota" };
				if ((options.maxRetries ?? 0) > 0) quotaAbort.abort();
			}
			try {
				options.signal?.throwIfAborted();
				const guard = requestGuard(target.account, repository, cwd);
				guard();
				active = reuse ? source : destination(target);
				let requestOptions = options;
				if (!reuse) {
					const auth = await context().modelRegistry.getApiKeyAndHeaders(active);
					guard();
					if (!auth.ok) throw new Error(auth.error);
					if (auth.baseUrl) active = { ...active, baseUrl: auth.baseUrl };
					requestOptions = { ...options, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
				}
				options.signal?.throwIfAborted();
				guard();
				const signal = options.signal ? AbortSignal.any([options.signal, quotaAbort.signal]) : quotaAbort.signal;
				const protectedOptions = protectChat(guard, {
					...requestOptions, signal, maxRetries: requestOptions.maxRetries ?? 0,
					fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
						const response = await (requestOptions.fetch ?? globalThis.fetch)(input, init);
						observe(await decodeQuotaResponse(target.account, response, options.signal));
						return response;
					},
				}, block);
				const hooks = {
					...protectedOptions,
					onProviderStreamEvent: (event: unknown, model: Model<Api>) => {
						if (rawHasOutput(event)) commit();
						observe(decodeQuotaPayload(target.account, event));
						return protectedOptions.onProviderStreamEvent!(event, model);
					},
				};
				for await (const event of native(target, active, hooks)) {
					const snapshot = structuredClone(event);
					if ("partial" in snapshot) partial = snapshot.partial;
					if (snapshot.type === "done") partial = snapshot.message;
					if (snapshot.type === "error") partial = snapshot.error;
					if (partial && hasOutput(partial)) commit();
					if (snapshot.type !== "start" && snapshot.type !== "done" && snapshot.type !== "error") commit();
					guard();
					if (snapshot.type === "done" || snapshot.type === "error") { terminal = snapshot; break; }
					if (snapshot.type === "start" && !hasOutput(snapshot.partial) && (attempt.progress.kind === "hidden" || attempt.progress.kind === "hidden-quota")) {
						start = snapshot;
						continue;
					}
					if (start) { output.push(start); start = undefined; }
					output.push(snapshot);
				}
				if (!terminal || terminal.type === "done") options.signal?.throwIfAborted();
				guard();
			} catch (error) { block(error); }
			if (attempt.progress.kind === "blocked" || !terminal) {
				const cause = attempt.progress.kind === "blocked" ? attempt.progress.cause : new Error("Provider stream ended without a terminal event");
				const message = { ...failure(active, cause, options.signal?.aborted), ...(partial ? { content: partial.content, usage: partial.usage } : {}) };
				return { kind: "stopped", terminal: { type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message }, start };
			}
			if (terminal.type === "done") return { kind: "answered", terminal, start };
			if (options.signal?.aborted || quotaAbort.signal.aborted) {
				terminal.reason = options.signal?.aborted ? "aborted" : "error";
				terminal.error.stopReason = terminal.reason;
			}
			if (options.signal?.aborted || terminal.reason === "aborted") return { kind: "stopped", terminal, start };
			if (attempt.progress.kind === "hidden-quota") return { kind: "quota-before-output", terminal, start };
			return { kind: "stopped", terminal, start };
		}
		(async () => {
			const targets = prepare(repository);
			for (let index = 0; index < targets.length; index++) {
				const target = targets[index];
				const reuse = index === 0 && source.provider === target.account.credential && source.id === target.modelId;
				const outcome = await consume(target, reuse);
				if (outcome.kind === "quota-before-output" && index + 1 < targets.length) continue;
				if (outcome.start) output.push(outcome.start);
				const message = outcome.terminal.type === "done" ? outcome.terminal.message : outcome.terminal.error;
				if (source.provider === REVIEW && target.account.credential !== COPILOT_ACCOUNT.credential && (outcome.kind === "answered" || hasOutput(message))) notice(REVIEW_NOTICE);
				output.push(outcome.terminal);
				output.end();
				return;
			}
		})().catch(error => {
			const message = failure(source, error, options.signal?.aborted);
			output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			output.end();
		});
		return output;
	}

	function codexProvider(entry: CodexAccount): Provider<CodexApi> {
		function prepare(source: Model<CodexApi>, repository: RepoScope) {
			requireAccount(entry, repository);
			codexSource(source);
			return candidates({ kind: "codex-policy", modelId: codexModelId(source.id) }, repository);
		}
		const stream: Provider<CodexApi>["stream"] = <T extends CodexApi>(source: Model<T>, transcript: TranscriptContext, options?: ApiStreamOptions<T>) => openStream(
			{ ...source, provider: entry.credential }, options ?? {}, repository => prepare(source, repository),
			target => {
				const model = physical(target);
				if (!hasApi(model, source.api)) throw new Error("Configured Codex target has an incompatible API");
				return model;
			},
			(_target, model, hooks) => codex.stream<CodexApi>(model, transcript, hooks),
		);
		const streamSimple: Provider<CodexApi>["streamSimple"] = (source, transcript, options = {}) => openStream(
			{ ...source, provider: entry.credential }, options, repository => prepare(source, repository),
			target => codexSource(physical(target)), (_target, model, hooks) => codex.streamSimple(model, transcript, hooks),
		);
		return {
			...codex, id: entry.credential, name: `${codex.name} (${entry === WORK_ACCOUNT ? "work" : "personal"})`,
			getModels: () => codex.getModels().map(model => ({ ...model, provider: entry.credential })),
			...(codex.getAllModels ? { getAllModels: () => codex.getAllModels!().map(model => ({ ...model, provider: entry.credential })) } : {}),
			auth: guardedAuth(codex.auth, () => discoverable(entry), () => requireAccount(entry)),
			...guardedAvailability(codex, () => discoverable(entry)), stream, streamSimple,
		};
	}
	const copilotStream: Provider<CopilotApi>["stream"] = <T extends CopilotApi>(source: Model<T>, transcript: TranscriptContext, options?: ApiStreamOptions<T>) => {
		return copilot.stream({ ...source, provider: COPILOT_ACCOUNT.credential }, transcript, protectChat(requestGuard(COPILOT_ACCOUNT), options));
	};
	const copilotSimple: Provider<CopilotApi>["streamSimple"] = (source, transcript, options) => {
		return copilot.streamSimple({ ...source, provider: COPILOT_ACCOUNT.credential }, transcript, protectChat(requestGuard(COPILOT_ACCOUNT), options));
	};
	const nativeClassify = copilot.classify;
	if (!nativeClassify) throw new Error("SDK Copilot classifier is missing");
	const classify: NonNullable<Provider["classify"]> = async (source, transcript, options) => {
		const model = { ...source, provider: COPILOT_ACCOUNT.credential };
		try {
			return await nativeClassify(model, transcript, protectRequest(requestGuard(COPILOT_ACCOUNT), options));
		} catch (error) {
			return {
				api: model.api, provider: model.provider, model: model.id, answers: {},
				stopReason: options?.signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
			};
		}
	};
	const protectedCopilot: Provider<CopilotApi> = {
		...copilot, auth: guardedAuth(copilot.auth, () => discoverable(COPILOT_ACCOUNT), () => requireAccount(COPILOT_ACCOUNT)),
		...guardedAvailability(copilot, () => discoverable(COPILOT_ACCOUNT)), stream: copilotStream, streamSimple: copilotSimple, classify,
	};
	const review: Provider = {
		id: REVIEW, name: "Profile review", getModels: () => reviewModels, getAllModels: () => reviewModels,
		auth: { apiKey: {
			name: "Review routing",
			async check() { return reviewAllowed() ? { type: "api_key" as const, source: "routing" } : undefined; },
			async resolve() { requireReview(scope()); return { auth: {}, source: "routing" }; },
		} },
		filterModels: models => reviewAllowed() ? models : [],
		filterAllModels: models => reviewAllowed() ? models : [],
		stream() { throw new Error("profile-review requires provider-neutral streamSimple options"); },
		streamSimple(source, transcript, options: SimpleStreamOptions = {}) {
			return openStream(
				{ ...source, provider: REVIEW }, options,
				repository => selectAvailable(requireReview(repository, source)), physical,
				(target, model, hooks) => target.account.credential === COPILOT_ACCOUNT.credential
					? copilot.streamSimple(copilotSource(model), transcript, hooks)
					: codex.streamSimple(codexSource(model), transcript, hooks),
			);
		},
	};
	const selections: VirtualModel[] = codex.getModels().map(model => ({
		provider: POLICY, id: model.id, name: `${model.name} (repo policy)`,
		thinkingLevels: getSupportedThinkingLevels(model), input: model.input,
		contextWindow: model.contextWindow, maxTokens: model.maxTokens,
		route(request) {
			return { model: physical(candidates({ kind: "codex-policy", modelId: codexModelId(model.id) }, scope())[0]), thinkingLevel: request.thinkingLevel };
		},
	}));
	if (policy.review && !reviewModels.length) selections.push({
		provider: REVIEW, id: policy.review.primary, name: "Configured review unavailable",
		route() { throw new Error("Configured review targets are unavailable or incompatible"); },
	});
	return { providers: [codexProvider(PERSONAL_ACCOUNT), codexProvider(WORK_ACCOUNT), protectedCopilot, review], selections };
}
