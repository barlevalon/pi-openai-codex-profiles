import { createAssistantMessageEventStream, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Provider, StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repoScope, type RepoScope } from "./scope.ts";
import type { Policy } from "./policy.ts";
import { reviewModel } from "./review.ts";
import { quotaResponse, quotaUntil, type QuotaLedger } from "./quota.ts";
import { codexModelId, type Account, type BudgetView, type CodexModelId, type CodexTarget, type Target } from "./targets.ts";

type Model = ReturnType<Provider["getModels"]>[number];
type Context = Parameters<Provider["streamSimple"]>[1];
type VirtualModel = Parameters<ExtensionAPI["registerVirtualModel"]>[0];
type Terminal = Extract<AssistantMessageEvent, { type: "done" | "error" }>;
type Start = Extract<AssistantMessageEvent, { type: "start" }>;
export const PERSONAL = "openai-codex:personal";
export const WORK = "openai-codex:work";
export const REVIEW = "profile-review";
export const POLICY = "codex-policy";
const COPILOT = "github-copilot";
export const REVIEW_NOTICE = "Routing notice. This review used the configured Codex fallback after Copilot quota exhaustion.";

function copyTarget<T extends Target>(target: T): T {
	return Object.freeze({ ...target });
}

class OrderedPlan<T extends Target> {
	readonly #sequence: readonly [T, ...T[]];
	private constructor(first: T, rest: readonly T[]) {
		this.#sequence = Object.freeze([copyTarget(first), ...rest.map(copyTarget)]);
		Object.freeze(this);
	}
	static from<T extends Target>(first: T, rest: readonly T[]) { return new OrderedPlan(first, rest); }
	get targets() { return this.#sequence; }
}
export type RoutePlan<T extends Target = Target> = OrderedPlan<T>;
export type PlanningResult<T extends Target> =
	| Readonly<{ kind: "planned"; plan: RoutePlan<T> }>
	| Readonly<{ kind: "blocked"; reason: "all-cooling" | "personal-unreadable" | "review-unreadable" | "review-not-ready" }>;

function codexCandidates(policy: Policy, model: CodexModelId, scope: RepoScope): CodexTarget[] {
	const order = scope === "eligible" ? policy.accountOrder : ["personal"] as const;
	return order.map(account => ({ service: "codex", account, model }));
}

function reviewCandidates(policy: Policy, scope: RepoScope): Target[] {
	if (policy.review.kind !== "ready") return [];
	const { primary, fallback } = policy.review.binding;
	return [{ service: "copilot-review", model: primary }, ...codexCandidates(policy, fallback, scope)];
}

function availablePlan<T extends Target>(candidates: readonly T[], budgets: BudgetView): PlanningResult<T> {
	const available: T[] = [];
	for (const target of candidates) {
		const state = target.service === "codex" ? budgets[target.account] : budgets.review;
		if (state.kind === "unreadable") {
			if (target.service === "copilot-review") return { kind: "blocked", reason: "review-unreadable" };
			if (target.account === "personal") return { kind: "blocked", reason: "personal-unreadable" };
		} else if (state.kind === "available") available.push(target);
	}
	const [first, ...rest] = available;
	return first ? { kind: "planned", plan: OrderedPlan.from(first, rest) } : { kind: "blocked", reason: "all-cooling" };
}

export function planCodex(policy: Policy, model: CodexModelId, scope: RepoScope, budgets: BudgetView): PlanningResult<CodexTarget> {
	return availablePlan(codexCandidates(policy, model, scope), budgets);
}

export function planReview(policy: Policy, scope: RepoScope, budgets: BudgetView): PlanningResult<Target> {
	if (policy.review.kind !== "ready") return { kind: "blocked", reason: "review-not-ready" };
	return availablePlan(reviewCandidates(policy, scope), budgets);
}

function requirePlan<T extends Target>(result: PlanningResult<T>): RoutePlan<T> {
	if (result.kind === "planned") return result.plan;
	const messages = {
		"all-cooling": "All configured routing targets are cooling down",
		"personal-unreadable": "Cannot read personal Codex quota state",
		"review-unreadable": "Cannot read Copilot quota state",
		"review-not-ready": "Review is not configured for this selection",
	};
	throw new Error(messages[result.reason]);
}

class ProviderQuota {
	readonly #observation: Readonly<{ target: Target; until: number }>;
	private constructor(target: Target, until: number) {
		this.#observation = Object.freeze({ target: copyTarget(target), until });
		Object.freeze(this);
	}
	static observed(target: Target, until: number) { return new ProviderQuota(target, until); }
	get target() { return this.#observation.target; }
	get until() { return this.#observation.until; }
}
export type DirectQuotaProof = ProviderQuota;

class RetryableQuota {
	readonly #settlement: DirectQuotaProof;
	private constructor(proof: DirectQuotaProof) {
		this.#settlement = proof;
		Object.freeze(this);
	}
	static settled(proof: DirectQuotaProof) { return new RetryableQuota(proof); }
	get kind() { return "quota-before-output" as const; }
	get proof() { return this.#settlement; }
}
export type RetryableQuotaFailure = RetryableQuota;
export type AttemptOutcome =
	| Readonly<{ kind: "answered" }>
	| Readonly<{ kind: "stopped"; reason: "error" | "aborted" }>
	| RetryableQuotaFailure;
type AttemptState =
	| Readonly<{ kind: "hidden" }>
	| Readonly<{ kind: "hidden-quota"; proof: DirectQuotaProof }>
	| Readonly<{ kind: "committed" }>
	| Readonly<{ kind: "blocked"; cause: "hook" | "setup" | "authorization" | "malformed" }>
	| Readonly<{ kind: "settled"; outcome: AttemptOutcome }>;
type Settlement = Readonly<{ outcome: AttemptOutcome; terminal: Terminal; start?: Start }>;

function hasOutput(message: AssistantMessage) {
	return message.content.length > 0 || Object.values(message.usage).some(value => typeof value === "number" && value > 0)
		|| Object.values(message.usage.cost).some(value => Number(value) > 0);
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

function providerId(target: Target) {
	return target.service === "codex" ? target.account === "work" ? WORK : PERSONAL : COPILOT;
}

export type ReviewRegistration =
	| Readonly<{ kind: "disabled" }>
	| Readonly<{ kind: "unavailable"; selection: VirtualModel }>
	| Readonly<{ kind: "ready"; provider: Provider }>;
export interface NativeRouting {
	accountProvider(account: Account): Provider;
	codexSelection(model: Model): VirtualModel;
	readonly reviewRegistration: ReviewRegistration;
}

export function createNativeRouting(codex: Provider, copilot: Provider, current: () => ExtensionContext | undefined, quota: QuotaLedger, notice: (message: string) => void, policy: Policy): NativeRouting {
	function context() {
		const ctx = current();
		if (!ctx) throw new Error("Codex routing requires an active Pi session");
		return ctx;
	}
	function guardWork() {
		if (!current() || !policy.accountOrder.some(account => account === "work") || repoScope(current()?.cwd, policy.work) !== "eligible") throw new Error("Work Codex is restricted to configured eligible repositories");
	}
	function physical(target: Target): Model {
		const model = context().modelRegistry.find(providerId(target), target.model);
		if (!model) throw new Error("Configured routing target is not registered");
		return model;
	}
	function codexPlan(model: CodexModelId) {
		const scope = repoScope(current()?.cwd, policy.work);
		return requirePlan(planCodex(policy, model, scope, quota.snapshot(codexCandidates(policy, model, scope), Date.now())));
	}
	function reviewPlan(id: string) {
		if (policy.review.kind !== "ready" || id !== policy.review.binding.primary) throw new Error("Review is not configured for this selection");
		const binding = policy.review.binding;
		reviewModel(binding, copilot.getModels().find(model => model.id === binding.primary), codex.getModels().find(model => model.id === binding.fallback));
		const scope = repoScope(current()?.cwd, policy.work);
		const candidates = reviewCandidates(policy, scope);
		const primary = physical({ service: "copilot-review", model: binding.primary });
		const advertised = context().modelRegistry.find(REVIEW, binding.primary);
		if (!advertised) throw new Error("Configured routing target is not registered");
		for (const target of candidates) {
			if (target.service === "codex") reviewModel(binding, primary, physical(target), advertised);
		}
		return requirePlan(planReview(policy, scope, quota.snapshot(candidates, Date.now())));
	}

	class Attempt<T extends Target, O extends StreamOptions> {
		readonly #target: T;
		readonly #source: Model;
		readonly #transcript: Context;
		readonly #options: O;
		readonly #sourceAccount: Account | undefined;
		readonly #native: (target: T, model: Model, transcript: Context, options: O) => AssistantMessageEventStream;
		readonly #retryCancellation = new AbortController();
		#state: AttemptState = { kind: "hidden" };
		#active: Model;
		#partial: AssistantMessage | undefined;

		constructor(target: T, source: Model, transcript: Context, options: O, native: (target: T, model: Model, transcript: Context, options: O) => AssistantMessageEventStream, sourceAccount?: Account) {
			this.#target = copyTarget(target);
			this.#source = source;
			this.#active = source;
			this.#transcript = transcript;
			this.#options = { ...options };
			this.#native = native;
			this.#sourceAccount = sourceAccount;
		}

		#block(cause: Extract<AttemptState, { kind: "blocked" }>["cause"]) {
			if (this.#state.kind !== "settled" && this.#state.kind !== "blocked") this.#state = { kind: "blocked", cause };
		}
		#guard() {
			if (this.#target.service !== "codex" || this.#target.account !== "work") return;
			try { guardWork(); } catch (error) { this.#block("authorization"); throw error; }
		}
		#commit() {
			if (this.#state.kind === "hidden" || this.#state.kind === "hidden-quota") this.#state = { kind: "committed" };
		}
		#observe(until: number | undefined) {
			if (until === undefined) return;
			const proof = ProviderQuota.observed(this.#target, until);
			quota.observeDirect(proof);
			if (this.#state.kind === "hidden" || this.#state.kind === "hidden-quota") this.#state = { kind: "hidden-quota", proof };
			if ((this.#options.maxRetries ?? 0) > 0) this.#retryCancellation.abort();
		}
		#settle(terminal: Terminal, start?: Start): Settlement {
			let outcome: AttemptOutcome;
			if (terminal.type === "done") outcome = Object.freeze({ kind: "answered" });
			else {
				if (hasOutput(terminal.error)) this.#commit();
				if (this.#options.signal?.aborted || this.#retryCancellation.signal.aborted) {
					terminal.reason = this.#options.signal?.aborted ? "aborted" : "error";
					terminal.error.stopReason = terminal.reason;
				}
				if (this.#options.signal?.aborted) outcome = Object.freeze({ kind: "stopped", reason: "aborted" });
				else if (this.#state.kind === "blocked") outcome = Object.freeze({ kind: "stopped", reason: terminal.reason });
				else if (terminal.reason === "aborted") outcome = Object.freeze({ kind: "stopped", reason: "aborted" });
				else if (this.#state.kind === "hidden-quota") outcome = RetryableQuota.settled(this.#state.proof);
				else outcome = Object.freeze({ kind: "stopped", reason: "error" });
			}
			this.#state = Object.freeze({ kind: "settled", outcome });
			return { outcome, terminal, start };
		}

		async run(output: AssistantMessageEventStream): Promise<Settlement> {
			try {
				this.#options.signal?.throwIfAborted();
				const reuseSource = this.#target.service === "codex" && this.#sourceAccount === this.#target.account && this.#source.id === this.#target.model;
				this.#active = reuseSource ? this.#source : physical(this.#target);
				this.#guard();
				let requestOptions = this.#options;
				if (!reuseSource) {
					const auth = await context().modelRegistry.getApiKeyAndHeaders(this.#active);
					this.#guard();
					if (!auth.ok) throw new Error(auth.error);
					this.#active = auth.baseUrl ? { ...this.#active, baseUrl: auth.baseUrl } : this.#active;
					requestOptions = { ...this.#options, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
				}
				this.#options.signal?.throwIfAborted();
				this.#guard();
				const signal = this.#options.signal ? AbortSignal.any([this.#options.signal, this.#retryCancellation.signal]) : this.#retryCancellation.signal;
				const hooks = {
					...requestOptions, signal, maxRetries: requestOptions.maxRetries ?? 0,
					fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
						this.#guard();
						const response = await (requestOptions.fetch ?? globalThis.fetch)(input, init);
						this.#observe(await quotaResponse(this.#target.service, response, this.#options.signal));
						this.#guard();
						return response;
					},
					onPayload: async (...args: Parameters<NonNullable<StreamOptions["onPayload"]>>) => {
						try {
							this.#guard();
							const value = await requestOptions.onPayload?.(...args);
							this.#guard();
							return value;
						} catch (error) { this.#block("hook"); throw error; }
					},
					onResponse: async (...args: Parameters<NonNullable<StreamOptions["onResponse"]>>) => {
						try {
							this.#guard();
							await requestOptions.onResponse?.(...args);
							this.#guard();
						} catch (error) { this.#block("hook"); throw error; }
					},
					onProviderStreamEvent: async (...args: Parameters<NonNullable<StreamOptions["onProviderStreamEvent"]>>) => {
						if (rawHasOutput(args[0])) this.#commit();
						this.#observe(quotaUntil(this.#target.service, args[0]));
						try {
							this.#guard();
							await requestOptions.onProviderStreamEvent?.(...args);
							this.#guard();
						} catch (error) { this.#block("hook"); throw error; }
					},
				};
				let start: Start | undefined;
				let terminal: Terminal | undefined;
				for await (const event of this.#native(this.#target, this.#active, this.#transcript, hooks)) {
					const snapshot = structuredClone(event);
					if ("partial" in snapshot) this.#partial = snapshot.partial;
					if (snapshot.type === "done" || snapshot.type === "error") { terminal = snapshot; break; }
					if (snapshot.type === "start" && !hasOutput(snapshot.partial) && (this.#state.kind === "hidden" || this.#state.kind === "hidden-quota")) {
						start = snapshot;
						continue;
					}
					this.#commit();
					if (start) { output.push(start); start = undefined; }
					output.push(snapshot);
				}
				if (terminal) return this.#settle(terminal, start);
				this.#block("malformed");
				throw new Error("Provider stream ended without a terminal event");
			} catch (error) {
				this.#block("setup");
				const partial = this.#partial;
				const message = { ...partial, ...failure(this.#active, error, this.#options.signal?.aborted), ...(partial ? { content: partial.content, usage: partial.usage } : {}) };
				return this.#settle({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			}
		}
	}

	function openStream<T extends Target, O extends StreamOptions>(source: Model, transcript: Context, options: O, prepare: () => RoutePlan<T>, native: (target: T, model: Model, transcript: Context, options: O) => AssistantMessageEventStream, sourceAccount?: Account) {
		const output = createAssistantMessageEventStream();
		(async () => {
			const plan = prepare();
			for (let index = 0; index < plan.targets.length; index++) {
				const target = plan.targets[index];
				const attempt = new Attempt(target, source, transcript, options, native, index === 0 ? sourceAccount : undefined);
				const { outcome, terminal, start } = await attempt.run(output);
				if (outcome instanceof RetryableQuota && index + 1 < plan.targets.length) continue;
				if (start) output.push(start);
				const message = terminal.type === "done" ? terminal.message : terminal.error;
				if (source.provider === REVIEW && target.service === "codex" && (outcome.kind === "answered" || hasOutput(message))) notice(REVIEW_NOTICE);
				output.push(terminal);
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

	function accountProvider(account: Account): Provider {
		const id = account === "work" ? WORK : PERSONAL;
		function prepare(source: Model) {
			if (account === "work") guardWork();
			return codexPlan(codexModelId(source.id));
		}
		const stream: Provider["stream"] = (source, transcript, options) => openStream(
			{ ...source, provider: id }, transcript, options ?? {}, () => prepare(source),
			(_target, model, context, hooks) => codex.stream(model, context, hooks), account,
		);
		const streamSimple: Provider["streamSimple"] = (source, transcript, options = {}) => openStream(
			{ ...source, provider: id }, transcript, options, () => prepare(source),
			(_target, model, context, hooks) => codex.streamSimple(model, context, hooks), account,
		);
		const oauth = codex.auth.oauth!;
		return {
			...codex, id, name: `${codex.name} (${account})`,
			getModels: () => codex.getModels().map(model => ({ ...model, provider: id })),
			...(codex.getAllModels ? { getAllModels: () => codex.getAllModels!().map(model => ({ ...model, provider: id })) } : {}),
			auth: { ...codex.auth, oauth: account === "work" ? {
				...oauth,
				// Scope authorizes refresh start. Native Pi must persist any rotated token under its lock.
				async refresh(...args) { guardWork(); return oauth.refresh(...args); },
				async toAuth(...args) { guardWork(); const result = await oauth.toAuth(...args); guardWork(); return result; },
			} : oauth },
			stream, streamSimple,
		};
	}

	function codexSelection(model: Model): VirtualModel {
		const id = codexModelId(model.id);
		return {
			provider: POLICY, id, name: `${model.name} (repo policy)`,
			thinkingLevels: getSupportedThinkingLevels(model), input: model.input,
			contextWindow: model.contextWindow, maxTokens: model.maxTokens,
			route(request) { return { model: physical(codexPlan(id).targets[0]), thinkingLevel: request.thinkingLevel }; },
		};
	}

	function reviewRegistration(): ReviewRegistration {
		if (policy.review.kind !== "ready") return { kind: "disabled" };
		const binding = policy.review.binding;
		try {
			const model = reviewModel(binding, copilot.getModels().find(model => model.id === binding.primary), codex.getModels().find(model => model.id === binding.fallback));
			const provider: Provider = {
				id: REVIEW, name: "Profile review", getModels: () => [model], getAllModels: () => [model],
				auth: { apiKey: { name: "Review routing", async resolve() { return { auth: {}, source: "routing" }; } } },
				stream() { throw new Error("profile-review requires provider-neutral streamSimple options"); },
				streamSimple: (source, transcript, options = {}) => openStream(
					{ ...source, provider: REVIEW }, transcript, options, () => reviewPlan(source.id),
					(target, model, context, hooks) => (target.service === "codex" ? codex : copilot).streamSimple(model, context, hooks),
				),
			};
			return { kind: "ready", provider };
		} catch {
			return { kind: "unavailable", selection: {
				provider: REVIEW, id: binding.primary, name: "Configured review unavailable",
				route() { throw new Error("Configured review targets are unavailable or incompatible"); },
			} };
		}
	}
	return { accountProvider, codexSelection, reviewRegistration: reviewRegistration() };
}
