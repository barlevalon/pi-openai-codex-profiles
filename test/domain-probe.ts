import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Provider, type StreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePolicy } from "../policy.ts";
import { createQuotaLedger, type QuotaLedger } from "../quota.ts";
import { createNativeRouting, planCodex, planReview, type DirectQuotaProof } from "../routing.ts";
import * as routingAPI from "../routing.ts";
import * as policyAPI from "../policy.ts";
import { reviewContribution, reviewModel } from "../review.ts";
import { codexModelId, copilotModelId, type AccountOrder, type BudgetView, type Target } from "../targets.ts";

type Model = ReturnType<Provider["getModels"]>[number];
const codex = builtinProviders().find(provider => provider.id === "openai-codex")!;
const copilot = builtinProviders().find(provider => provider.id === "github-copilot")!;
const fallback = codex.getModels().find(model => model.id === "gpt-5.6-luna")!;
const primary = copilot.getModels().find(model => model.id === "claude-sonnet-5.5")!;
const personal: Target = { service: "codex", account: "personal", model: codexModelId(fallback.id) };
const work: Target = { service: "codex", account: "work", model: codexModelId(fallback.id) };
const review: Target = { service: "copilot-review", model: copilotModelId(primary.id) };

function message(model: Model): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: "error",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function eligibleCheckout() {
	const root = join(getAgentDir(), "repositories");
	const cwd = join(root, "checkout");
	mkdirSync(cwd, { recursive: true });
	execFileSync("git", ["-C", cwd, "init", "-q"]);
	return { root, cwd };
}

function registryContext(ctx: ExtensionContext, advertised?: Model): ExtensionContext {
	const find: ExtensionContext["modelRegistry"]["find"] = (provider, id) => {
		if (provider === "profile-review") return advertised?.id === id ? advertised : undefined;
		const model = (provider === "github-copilot" ? copilot : codex).getModels().find(model => model.id === id);
		return model && { ...model, provider };
	};
	const auth: ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"] = async () => ({ ok: true, apiKey: "fake-destination", headers: { destination: "only" }, env: { DESTINATION: "only" } });
	return { ...ctx, modelRegistry: new Proxy(ctx.modelRegistry, { get(target, key, receiver) {
		if (key === "find") return find;
		if (key === "getApiKeyAndHeaders") return auth;
		return Reflect.get(target, key, receiver);
	} }) };
}

async function directObservation(ctx: ExtensionContext, ledger: QuotaLedger, target: Target, until: number): Promise<DirectQuotaProof> {
	const { root, cwd } = eligibleCheckout();
	const policy = parsePolicy({
		version: 1, accountOrder: target.service === "codex" && target.account === "work" ? ["work", "personal"] : ["personal"],
		work: { roots: [root] }, review: { copilotModel: primary.id, codexFallbackModel: fallback.id },
	});
	assert.equal(policy.review.kind, "ready");
	if (policy.review.kind !== "ready") throw new Error("Missing test review binding");
	const advertised = reviewModel(policy.review.binding, primary, fallback);
	let observed: DirectQuotaProof | undefined;
	const capture: QuotaLedger = {
		snapshot: (candidates, now) => ledger.snapshot(candidates, now),
		observeDirect(proof) { observed = proof; ledger.observeDirect(proof); },
	};
	const streamSimple: Provider["streamSimple"] = (model, _transcript, options = {}) => {
		const stream = createAssistantMessageEventStream();
		(async () => {
			const result = message(model);
			if (model.provider === (target.service === "codex" ? `openai-codex:${target.account}` : "github-copilot")) {
				if (target.service === "codex") await options.onProviderStreamEvent?.({ type: "error", error: { code: "usage_limit_reached", resets_at: until / 1000 } }, model);
				else await options.fetch!("http://fixture.invalid", {});
				stream.push({ type: "error", reason: "error", error: result });
			} else {
				result.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: result });
			}
			stream.end();
		})().catch(error => {
			stream.push({ type: "error", reason: "error", error: { ...message(model), errorMessage: String(error) } });
			stream.end();
		});
		return stream;
	};
	const routing = createNativeRouting({ ...codex, streamSimple }, { ...copilot, streamSimple }, () => ({ ...registryContext(ctx, advertised), cwd }), capture, () => {}, policy);
	if (target.service === "codex") await routing.accountProvider(target.account).streamSimple({ ...fallback, provider: `openai-codex:${target.account}` }, normalizeContext({ messages: [] }), { apiKey: "fake" }).result();
	else {
		assert.equal(routing.reviewRegistration.kind, "ready");
		if (routing.reviewRegistration.kind !== "ready") throw new Error("Missing test review provider");
		await routing.reviewRegistration.provider.streamSimple(advertised, normalizeContext({ messages: [] }), {
			fetch: async () => new Response(JSON.stringify({ error: { code: "quota_exceeded" } }), { status: 402, headers: { "retry-after": new Date(until).toUTCString() } }),
		}).result();
	}
	assert.ok(observed, "only the bound native decoder supplies direct proof");
	return observed;
}

async function quotaCorruption(ctx: ExtensionContext) {
	const directory = join(getAgentDir(), "quotas");
	const until = Math.floor(Date.now() / 1000) * 1000 + 600000;
	const writer = createQuotaLedger(directory, assert.fail);
	const proof = await directObservation(ctx, writer, review, until);
	const reader = createQuotaLedger(directory, assert.fail);
	assert.deepEqual(reader.snapshot([review], Date.now()).review, { kind: "cooling", until });
	writeFileSync(join(directory, "copilot-review.bad.json"), "{}");
	assert.equal(reader.snapshot([review], Date.now()).review.kind, "unreadable", "cached disk evidence is not local evidence");
	assert.deepEqual(writer.snapshot([review], Date.now()).review, { kind: "cooling", until });
	reader.observeDirect(proof);
	assert.deepEqual(reader.snapshot([review], Date.now()).review, { kind: "cooling", until });
	assert.equal(reader.snapshot([review], until + 1).review.kind, "unreadable", "expired local evidence cannot mask corruption");
	const blocked = join(getAgentDir(), "blocked");
	writeFileSync(blocked, "not a directory");
	const warnings: string[] = [];
	const local = createQuotaLedger(blocked, warning => warnings.push(warning));
	local.observeDirect(proof);
	assert.equal(warnings.length, 1);
	assert.deepEqual(local.snapshot([review], Date.now()).review, { kind: "cooling", until }, "failed persistence retains direct evidence");
	assert.ok(Object.isFrozen(proof));
	assert.ok(Object.isFrozen(proof.target));
	assert.throws(() => Object.assign(proof.target, { model: codexModelId("changed") }), TypeError);
	assert.throws(() => Object.assign(proof, { target: work }), TypeError);
	assert.deepEqual({ ...proof }, {}, "spreading proof loses its private payload");
	const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proof), "target")!.get!;
	assert.throws(() => getter.call({ ...proof, target: work }), TypeError);
}

async function quotaWorker(ctx: ExtensionContext) {
	const directory = process.env.DOMAIN_QUOTA_DIRECTORY!;
	const until = Number(process.env.DOMAIN_QUOTA_UNTIL);
	const proof = await directObservation(ctx, createQuotaLedger(join(getAgentDir(), "native-evidence"), assert.fail), work, until);
	createQuotaLedger(directory, assert.fail).observeDirect(proof);
	assert.equal(proof.until, until);
	assert.deepEqual(proof.target, work);
	assert.equal(readdirSync(directory).some(name => name.startsWith("work-codex.") && name.endsWith(".json")), true);
}

function domainPlans() {
	const available = { kind: "available" } as const;
	const cooling = { kind: "cooling", until: Date.now() + 60000 } as const;
	const unreadable = { kind: "unreadable" } as const;
	const orders: AccountOrder[] = [["personal"], ["personal", "work"], ["work", "personal"]];
	for (const accountOrder of orders) for (const scope of ["eligible", "other", "unknown"] as const) {
		const policy = parsePolicy({ version: 1, accountOrder, work: { githubOwners: ["example-org"] }, review: { copilotModel: primary.id, codexFallbackModel: fallback.id } });
		for (const personalState of [available, cooling, unreadable]) for (const workState of [available, cooling, unreadable]) {
			const budgets: BudgetView = { personal: personalState, work: workState, review: available };
			const planned = planCodex(policy, codexModelId(fallback.id), scope, budgets);
			const candidates = scope === "eligible" ? accountOrder : ["personal"] as const;
			const expected = candidates.filter(account => budgets[account].kind === "available");
			if (personalState.kind === "unreadable") assert.deepEqual(planned, { kind: "blocked", reason: "personal-unreadable" });
			else if (!expected.length) assert.deepEqual(planned, { kind: "blocked", reason: "all-cooling" });
			else {
				assert.equal(planned.kind, "planned");
				if (planned.kind !== "planned") throw new Error("Missing test plan");
				assert.deepEqual(planned.plan.targets.map(target => target.account), expected);
				assert.equal(new Set(planned.plan.targets.map(target => target.account)).size, planned.plan.targets.length);
				assert.ok(planned.plan.targets.every(target => target.model === fallback.id));
			}
			const reviewPlan = planReview(policy, scope, budgets);
			if (personalState.kind === "unreadable") assert.deepEqual(reviewPlan, { kind: "blocked", reason: "personal-unreadable" });
			else {
				assert.equal(reviewPlan.kind, "planned");
				if (reviewPlan.kind !== "planned") throw new Error("Missing test review plan");
				assert.deepEqual(reviewPlan.plan.targets, [review, ...expected.map(account => ({ service: "codex", account, model: fallback.id }))]);
			}
		}
	}
	const disabled = parsePolicy({ version: 1, accountOrder: ["personal"] });
	const restricted = { personal: available, get work(): never { throw new Error("unrelated work budget inspected"); }, get review(): never { throw new Error("unrelated review budget inspected"); } };
	assert.equal(planCodex(disabled, codexModelId(fallback.id), "eligible", restricted).kind, "planned");
	assert.deepEqual(planReview(disabled, "eligible", restricted), { kind: "blocked", reason: "review-not-ready" });
	const policy = parsePolicy({ version: 1, accountOrder: ["personal"], review: { copilotModel: primary.id, codexFallbackModel: fallback.id } });
	assert.deepEqual(planReview(policy, "other", { personal: available, work: available, review: unreadable }), { kind: "blocked", reason: "review-unreadable" });
	const fallbackPlan = planReview(policy, "other", { personal: available, work: unreadable, review: cooling });
	assert.equal(fallbackPlan.kind, "planned");
	if (fallbackPlan.kind === "planned") assert.deepEqual(fallbackPlan.plan.targets, [personal]);
	assert.deepEqual(planReview(policy, "other", { personal: cooling, work: available, review: cooling }), { kind: "blocked", reason: "all-cooling" });
	let contribution = reviewContribution("none", { answerer: "codex", ending: "error" });
	assert.equal(contribution, "none");
	contribution = reviewContribution(contribution, { answerer: "codex", ending: "aborted" });
	assert.equal(contribution, "none");
	contribution = reviewContribution(contribution, { answerer: "codex", ending: "tool" });
	assert.equal(contribution, "codex");
	assert.equal(reviewContribution(contribution, { answerer: "copilot", ending: "stop" }), "codex");
}

function authority() {
	const input = { version: 1, accountOrder: ["work", "personal"], work: { githubOwners: ["example-org"], roots: ["/synthetic/root"] }, review: { copilotModel: primary.id, codexFallbackModel: fallback.id } };
	const policy = parsePolicy(input);
	input.accountOrder.reverse();
	input.work.githubOwners[0] = "changed";
	input.work.roots[0] = "/changed";
	input.review.codexFallbackModel = "changed";
	assert.deepEqual(policy.accountOrder, ["work", "personal"]);
	assert.deepEqual(policy.work, { githubOwners: ["example-org"], roots: ["/synthetic/root"] });
	assert.equal(policy.review.kind, "ready");
	if (policy.review.kind !== "ready") throw new Error("Missing test binding");
	const binding = policy.review.binding;
	assert.equal(binding.fallback, fallback.id);
	assert.throws(() => Object.assign(binding, { fallback: codexModelId("changed") }), TypeError);
	assert.throws(() => Object.assign(policy, { accountOrder: ["personal"] }), TypeError);
	assert.throws(() => Array.prototype.push.call(policy.accountOrder, "work"), TypeError);
	const planned = planReview(policy, "eligible", { personal: { kind: "available" }, work: { kind: "available" }, review: { kind: "available" } });
	assert.equal(planned.kind, "planned");
	if (planned.kind !== "planned") throw new Error("Missing test plan");
	const plan = planned.plan;
	for (const value of [policy, policy.review, binding, plan, plan.targets, ...plan.targets]) assert.ok(Object.isFrozen(value));
	assert.throws(() => Object.assign(plan.targets[0], { model: copilotModelId("changed") }), TypeError);
	assert.throws(() => Object.assign(plan, { targets: [personal, personal] }), TypeError);
	for (const [value, key] of [[policy, "accountOrder"], [binding, "fallback"], [plan, "targets"]] as const) {
		const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), key)!.get!;
		assert.throws(() => getter.call({ ...value }), TypeError);
	}
	for (const name of ["Attempt", "RetryableQuota", "ProviderQuota", "OrderedPlan", "finish", "routing"]) assert.equal(name in routingAPI, false, name);
	for (const name of ["BoundReview", "ParsedPolicy"]) assert.equal(name in policyAPI, false, name);
	const directory = join(getAgentDir(), "unrelated-budget");
	mkdirSync(directory);
	writeFileSync(join(directory, "copilot-review.bad.json"), "{}");
	writeFileSync(join(directory, "work-codex.bad.json"), "{}");
	assert.deepEqual(createQuotaLedger(directory, assert.fail).snapshot([personal], Date.now()), { personal: { kind: "available" }, work: { kind: "available" }, review: { kind: "available" } });
}

async function authScope(ctx: ExtensionContext) {
	const { root, cwd } = eligibleCheckout();
	const outside = getAgentDir();
	let calls = 0;
	let authCalls = 0;
	let begin: () => void = () => {};
	let release: () => void = () => {};
	const started = new Promise<void>(resolve => { begin = resolve; });
	const waiting = new Promise<void>(resolve => { release = resolve; });
	const base = registryContext(ctx);
	const resolveAuth: ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"] = async () => {
		authCalls++;
		begin();
		await waiting;
		return { ok: true, apiKey: "fake-work" };
	};
	const registry = new Proxy(base.modelRegistry, { get(target, key, receiver) { return key === "getApiKeyAndHeaders" ? resolveAuth : Reflect.get(target, key, receiver); } });
	let current = { ...base, cwd, modelRegistry: registry };
	const native = { ...codex, streamSimple() { calls++; assert.fail("scope changed during auth await reached native provider"); } };
	const policy = parsePolicy({ version: 1, accountOrder: ["work", "personal"], work: { roots: [root] } });
	const routing = createNativeRouting(native, copilot, () => current, createQuotaLedger(join(getAgentDir(), "auth-scope"), assert.fail), assert.fail, policy);
	const stream = routing.accountProvider("personal").streamSimple({ ...fallback, provider: "openai-codex:personal" }, normalizeContext({ messages: [] }), { apiKey: "fake-source" });
	await started;
	current = { ...current, cwd: outside };
	release();
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /restricted/);
	assert.equal(calls, 0);
	assert.equal(authCalls, 1);
	const workProvider = routing.accountProvider("work");
	for (const callback of [workProvider.stream, workProvider.streamSimple]) {
		const denied = await callback({ ...fallback, provider: "openai-codex:personal" }, normalizeContext({ messages: [] }), { apiKey: "fake-bypass", headers: { authorization: "fake-bypass" } }).result();
		assert.equal(denied.stopReason, "error");
		assert.match(denied.errorMessage!, /restricted/);
	}
	assert.equal(authCalls, 1, "registration captures the receiver even with a forged source provider");
	for (const operation of ["refresh", "toAuth"] as const) {
		current = { ...current, cwd };
		let nativeCalls = 0;
		const oauth = codex.auth.oauth!;
		const wrapped = { ...codex, auth: { ...codex.auth, oauth: { ...oauth,
			async refresh(credential: Parameters<typeof oauth.refresh>[0]) { nativeCalls++; current = { ...current, cwd: outside }; return credential; },
			async toAuth() { nativeCalls++; current = { ...current, cwd: outside }; return { apiKey: "fake-work" }; },
		} } };
		const guarded = createNativeRouting(wrapped, copilot, () => current, createQuotaLedger(join(getAgentDir(), `oauth-${operation}`), assert.fail), assert.fail, policy).accountProvider("work").auth.oauth!;
		const credential: Parameters<typeof oauth.refresh>[0] = { type: "oauth", access: "fake", refresh: "fake", expires: Date.now() + 60000 };
		await assert.rejects(() => operation === "refresh" ? guarded.refresh(credential, new AbortController().signal) : guarded.toAuth(credential), /restricted/);
		assert.equal(nativeCalls, 1, `${operation} rechecks after the native await`);
	}
	const alias = join(getAgentDir(), "authorized-root");
	symlinkSync(root, alias);
	const aliasPolicy = parsePolicy({ version: 1, accountOrder: ["work", "personal"], work: { roots: [alias] } });
	current = { ...current, cwd };
	const changedRegistry = new Proxy(base.modelRegistry, { get(target, key, receiver) {
		if (key === "getApiKeyAndHeaders") return async () => { unlinkSync(alias); symlinkSync(join(getAgentDir(), "different-root"), alias); return { ok: true, apiKey: "fake-work" }; };
		return Reflect.get(target, key, receiver);
	} });
	current = { ...current, modelRegistry: changedRegistry };
	const changed = createNativeRouting(native, copilot, () => current, createQuotaLedger(join(getAgentDir(), "auth-root"), assert.fail), assert.fail, aliasPolicy);
	const denied = await changed.accountProvider("personal").streamSimple({ ...fallback, provider: "openai-codex:personal" }, normalizeContext({ messages: [] })).result();
	assert.equal(denied.stopReason, "error");
	assert.match(denied.errorMessage!, /restricted/);
	assert.equal(calls, 0, "canonical roots are rechecked after auth awaits");
}

async function directSource(ctx: ExtensionContext) {
	const source = { ...fallback, id: "custom/direct-model", provider: "openai-codex:personal", baseUrl: "http://127.0.0.1:1/custom", headers: { "source-model": "retained" } };
	let calls = 0;
	const complete = (model: Model) => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: { ...message(model), stopReason: "stop" } });
		stream.end();
		return stream;
	};
	const inspect = (model: Model, options: StreamOptions) => {
		calls++;
		assert.equal(model.id, source.id);
		assert.equal(model.provider, "openai-codex:personal");
		assert.equal(model.baseUrl, source.baseUrl);
		assert.deepEqual(model.headers, source.headers);
		assert.equal(options.apiKey, "fake-source");
		assert.deepEqual(options.headers, { "source-only": "retained" });
		assert.deepEqual(options.env, { SOURCE: "retained" });
	};
	const native: Provider = { ...codex,
		stream(model, _transcript, options) {
			inspect(model, options ?? {});
			assert.equal(options && "reasoningEffort" in options && options.reasoningEffort, "high");
			assert.equal(options && "toolChoice" in options && options.toolChoice, "required");
			return complete(model);
		},
		streamSimple(model, _transcript, options = {}) { inspect(model, options); assert.equal(options.reasoning, "high"); return complete(model); },
	};
	const registry = new Proxy(ctx.modelRegistry, { get(target, key, receiver) {
		if (key === "find" || key === "getApiKeyAndHeaders") return () => assert.fail("valid reused direct source required synthetic catalog membership or destination auth");
		return Reflect.get(target, key, receiver);
	} });
	const policy = parsePolicy({ version: 1, accountOrder: ["personal"] });
	const routing = createNativeRouting(native, copilot, () => ({ ...ctx, modelRegistry: registry }), createQuotaLedger(join(getAgentDir(), "direct-source"), assert.fail), assert.fail, policy);
	const provider = routing.accountProvider("personal");
	const options = { apiKey: "fake-source", headers: { "source-only": "retained" }, env: { SOURCE: "retained" } };
	const raw = await provider.stream(source, normalizeContext({ messages: [] }), { ...options, reasoningEffort: "high", toolChoice: "required" }).result();
	const simple = await provider.streamSimple(source, normalizeContext({ messages: [] }), { ...options, reasoning: "high" }).result();
	for (const result of [raw, simple]) { assert.equal(result.stopReason, "stop"); assert.equal(result.model, source.id); }
	assert.equal(calls, 2);
	const invalid = await provider.streamSimple({ ...source, id: "" }, normalizeContext({ messages: [] }), options).result();
	assert.equal(invalid.stopReason, "error", "rejected native input returns a terminal stream");
}

async function attemptTransition(ctx: ExtensionContext) {
	const mode = process.env.DOMAIN_MODE!;
	const { root, cwd } = eligibleCheckout();
	const last = mode === "last-internal-quota";
	const policy = parsePolicy({ version: 1, accountOrder: last ? ["personal"] : ["work", "personal"], work: { roots: [root] } });
	const calls: string[] = [];
	const observed: DirectQuotaProof[] = [];
	const quota = createQuotaLedger(join(getAgentDir(), "attempt-quota"), assert.fail);
	const ledger: QuotaLedger = {
		snapshot: (candidates, now) => quota.snapshot(candidates, now),
		observeDirect(proof) { observed.push(proof); quota.observeDirect(proof); },
	};
	const caller = new AbortController();
	if (mode === "pre-aborted") caller.abort();
	const quotaEvent = { type: "error", error: { code: mode === "mutated-intro" ? "rate_limit_exceeded" : "usage_limit_reached" } };
	const usageEvent = { type: "response.failed", response: { usage: { input_tokens: 2 }, error: { code: "usage_limit_reached" } } };
	const streamSimple: Provider["streamSimple"] = (model, _transcript, options = {}) => {
		calls.push(model.provider);
		const output = createAssistantMessageEventStream();
		if (mode === "cleanup-caller-abort") {
			Object.defineProperty(output, Symbol.asyncIterator, { value: async function* () {
				try {
					await options.onProviderStreamEvent?.(quotaEvent, model);
					yield { type: "error", reason: "error", error: message(model) } as const;
				} finally { caller.abort(); }
			} });
			return output;
		}
		(async () => {
			const result = message(model);
			const emit = async (event: Parameters<typeof output.push>[0]) => { output.push(event); await setImmediate(); };
			await emit({ type: "start", partial: result });
			if (calls.length > 1 || mode === "empty-success") {
				result.stopReason = "stop";
				await emit({ type: "done", reason: "stop", message: result });
				output.end();
				return;
			}
			try {
				if (mode === "text" || mode === "missing-after-output") {
					result.content.push({ type: "text", text: "a" });
					await emit({ type: "text_delta", contentIndex: 0, delta: "a", partial: result });
					result.content[0] = { type: "text", text: "ab" };
				}
				if (mode === "thinking") { result.content.push({ type: "thinking", thinking: "thought" }); await emit({ type: "thinking_start", contentIndex: 0, partial: result }); }
				if (mode === "tool") { result.content.push({ type: "toolCall", id: "call", name: "fixture", arguments: {} }); await emit({ type: "toolcall_start", contentIndex: 0, partial: result }); }
				if (mode === "terminal-usage") result.usage.input = 2;
				if (mode === "terminal-cost") result.usage.cost.total = 0.1;
				if (mode === "provider-cost-marker") result.usage.cost.totalFromProvider = true;
				if (mode === "missing-terminal" || mode === "missing-after-output") { output.end(); return; }
				if (mode === "hook-before-quota") { try { await options.onResponse?.({ status: 200, headers: {} }, model); } catch {} }
				if (mode === "raw-usage" || mode === "mutated-usage") await options.onProviderStreamEvent?.(usageEvent, model);
				else {
					if (mode === "raw-output") await options.onProviderStreamEvent?.({ response: { output: [{ type: "reasoning", encrypted_content: "opaque" }] } }, model);
					await options.onProviderStreamEvent?.(quotaEvent, model);
				}
				if (mode === "hook-after-quota") await options.onResponse?.({ status: 429, headers: {} }, model);
				if (mode === "empty-success-after-quota") {
					result.stopReason = "stop";
					await emit({ type: "done", reason: "stop", message: result });
					output.end();
					return;
				}
			} catch (error) { result.errorMessage = String(error); }
			const reason = mode === "provider-abort" || options.signal?.aborted ? "aborted" : "error";
			result.stopReason = reason;
			await emit({ type: "error", reason, error: result });
			output.end();
		})().catch(error => { output.push({ type: "error", reason: "error", error: { ...message(model), errorMessage: String(error) } }); output.end(); });
		return output;
	};
	const routing = createNativeRouting({ ...codex, streamSimple }, copilot, () => ({ ...registryContext(ctx), cwd }), ledger, assert.fail, policy);
	const account = last || mode === "cleanup-caller-abort" ? "personal" : "work";
	const stream = routing.accountProvider(account).streamSimple({ ...fallback, provider: `openai-codex:${account}` }, normalizeContext({ messages: [] }), {
		apiKey: "fake-source", signal: caller.signal,
		maxRetries: ["internal-quota", "last-internal-quota", "caller-and-internal"].includes(mode) ? 3 : 0,
		onResponse() { if (mode === "hook-before-quota" || mode === "hook-after-quota") throw new Error("fixture response hook failed"); },
		onProviderStreamEvent() {
			if (mode === "mutated-intro") quotaEvent.error.code = "usage_limit_reached";
			if (mode === "mutated-quota") quotaEvent.error.code = "rate_limit_exceeded";
			if (mode === "mutated-usage") usageEvent.response.usage.input_tokens = 0;
			if (mode === "caller-abort" || mode === "caller-and-internal") caller.abort();
			if (mode === "event-hook") throw new Error("fixture stream hook failed");
		},
	});
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert.equal(events.filter(event => event.type === "done" || event.type === "error").length, 1);
	assert.equal(events.filter(event => event.type === "start").length <= 1, true);
	if (mode === "text" || mode === "missing-after-output") {
		assert.equal(events[0].type, "start");
		assert.equal("partial" in events[0] && events[0].partial.content.length, 0);
		assert.equal("partial" in events[1] && events[1].partial.content[0].type === "text" && events[1].partial.content[0].text, "a");
		assert.equal(result.content[0].type === "text" && result.content[0].text, mode === "text" ? "ab" : "a");
	}
	for (const proof of observed) {
		const snapshot = quota.snapshot([proof.target], Date.now());
		assert.equal(proof.target.service === "codex" ? snapshot[proof.target.account].kind : snapshot.review.kind, "cooling", "quota persists independently of retry permission");
	}
	return { calls, stopReason: result.stopReason, provider: result.provider, observations: observed.map(proof => proof.target), callerAborted: caller.signal.aborted, usage: result.usage };
}

export default function (pi: ExtensionAPI) {
	globalThis.fetch = async () => { throw new Error("Test blocked external fetch"); };
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (process.env.DOMAIN_CASE === "attempt") { pi.appendEntry("domain-probe", await attemptTransition(ctx)); return; }
			if (process.env.DOMAIN_CASE === "quota-worker") await quotaWorker(ctx);
			else if (process.env.DOMAIN_CASE === "quota-corruption") await quotaCorruption(ctx);
			else if (process.env.DOMAIN_CASE === "plans") domainPlans();
			else if (process.env.DOMAIN_CASE === "authority") authority();
			else if (process.env.DOMAIN_CASE === "auth-scope") await authScope(ctx);
			else if (process.env.DOMAIN_CASE === "direct-source") await directSource(ctx);
			else throw new Error("Unknown domain case");
			pi.appendEntry("domain-probe", { passed: process.env.DOMAIN_CASE });
		} catch (error) {
			pi.appendEntry("domain-probe", { error: String(error), stack: error instanceof Error ? error.stack : "" });
		}
	});
}
