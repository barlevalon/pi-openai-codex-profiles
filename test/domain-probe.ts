import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Provider, type StreamOptions } from "@earendil-works/pi-ai";
import type { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { nativeProviders } from "../native-guards.ts";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePolicy } from "../policy.ts";
import { createQuotaLedger, type QuotaLedger } from "../quota.ts";
import { decodeQuotaPayload, decodeQuotaResponse, type DirectObservation } from "../quota-protocol.ts";
import { routingFixture } from "./routing-fixture.ts";
import * as routingAPI from "../routing.ts";
import * as policyAPI from "../policy.ts";
import { reviewContribution } from "../review.ts";
import { COPILOT_ACCOUNT, PERSONAL_ACCOUNT, WORK_ACCOUNT, codexModelId, copilotModelId, eligibleCandidates, selectTargets, type ModelTarget } from "../targets.ts";

type Model = ReturnType<Provider["getModels"]>[number];
const codex = nativeProviders().codex;
const copilot = nativeProviders().copilot;
const fallback = codex.getModels().find(model => model.id === "gpt-5.6-luna")!;
const primary = copilot.getModels().find(model => model.id === "claude-sonnet-5.5")!;
const personal: ModelTarget = { account: PERSONAL_ACCOUNT, modelId: codexModelId(fallback.id) };
const work: ModelTarget = { account: WORK_ACCOUNT, modelId: codexModelId(fallback.id) };
const review: ModelTarget = { account: COPILOT_ACCOUNT, modelId: copilotModelId(primary.id) };

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

async function directObservation(ledger: QuotaLedger, target: ModelTarget, until: number): Promise<DirectObservation> {
	const observation = target.account.credential === "github-copilot"
		? await decodeQuotaResponse(target.account, new Response(JSON.stringify({ error: { code: "quota_exceeded" } }), { status: 402, headers: { "retry-after": new Date(until).toUTCString() } }))
		: decodeQuotaPayload(target.account, { type: "error", error: { code: "usage_limit_reached", resets_at: until / 1000 } });
	assert.ok(observation);
	ledger.observeDirect(observation);
	return observation;
}

async function quotaCorruption(_ctx: ExtensionContext) {
	const directory = join(getAgentDir(), "quotas");
	const until = Math.floor(Date.now() / 1000) * 1000 + 600000;
	const writer = createQuotaLedger(directory, assert.fail);
	const proof = await directObservation(writer, review, until);
	const reader = createQuotaLedger(directory, assert.fail);
	assert.deepEqual(reader.snapshot([review], Date.now()).get("copilot-review"), { kind: "cooling", until });
	writeFileSync(join(directory, "copilot-review.bad.json"), "{}");
	assert.equal(reader.snapshot([review], Date.now()).get("copilot-review")!.kind, "unreadable", "cached disk evidence is not local evidence");
	assert.deepEqual(writer.snapshot([review], Date.now()).get("copilot-review"), { kind: "cooling", until });
	reader.observeDirect(proof);
	assert.deepEqual(reader.snapshot([review], Date.now()).get("copilot-review"), { kind: "cooling", until });
	assert.equal(reader.snapshot([review], until + 1).get("copilot-review")!.kind, "unreadable", "expired local evidence cannot mask corruption");
	const blocked = join(getAgentDir(), "blocked");
	writeFileSync(blocked, "not a directory");
	const warnings: string[] = [];
	const local = createQuotaLedger(blocked, warning => warnings.push(warning));
	local.observeDirect(proof);
	assert.equal(warnings.length, 1);
	assert.deepEqual(local.snapshot([review], Date.now()).get("copilot-review"), { kind: "cooling", until });
	assert.ok(Object.isFrozen(proof));
	assert.ok(Object.isFrozen(proof.account));
	assert.throws(() => Object.assign(proof.account, { budget: "work-codex" }), TypeError);
	assert.throws(() => Object.assign(proof, { account: WORK_ACCOUNT }), TypeError);
	assert.deepEqual({ ...proof }, {}, "spreading proof loses its private payload");
	assert.throws(() => Reflect.apply(local.observeDirect, local, [{ ...proof, account: WORK_ACCOUNT, until }]), TypeError);
}

async function quotaWorker(_ctx: ExtensionContext) {
	const directory = process.env.DOMAIN_QUOTA_DIRECTORY!;
	const until = Number(process.env.DOMAIN_QUOTA_UNTIL);
	const proof = await directObservation(createQuotaLedger(join(getAgentDir(), "native-evidence"), assert.fail), work, until);
	createQuotaLedger(directory, assert.fail).observeDirect(proof);
	assert.equal(proof.until, until);
	assert.equal(proof.account, WORK_ACCOUNT);
	assert.equal(readdirSync(directory).some(name => name.startsWith("work-codex.") && name.endsWith(".json")), true);
}

function domainPlans() {
	const policy = parsePolicy({ version: 1, accountOrder: ["work", "personal"], copilotProfile: "work", work: { githubOwners: ["example-org"] }, review: { copilotModel: primary.id, codexFallbackModel: fallback.id } });
	for (const scope of ["other", "unknown"] as const) assert.deepEqual(eligibleCandidates(policy, scope, { kind: "review" }), { kind: "unavailable", reason: "profile-denied" });
	const eligible = eligibleCandidates(policy, "eligible", { kind: "review" });
	assert.equal(eligible.kind, "eligible");
	if (eligible.kind !== "eligible") throw new Error("Missing eligible review");
	assert.deepEqual(eligible.targets, [review, work, personal]);
	const ready = selectTargets(eligible.targets, new Map([
		["copilot-review", { kind: "cooling", until: Date.now() + 10000 }],
		["work-codex", { kind: "unreadable" }],
		["personal-codex", { kind: "available" }],
	]));
	assert.equal(ready.kind, "selected");
	if (ready.kind === "selected") assert.deepEqual(ready.targets, [personal]);
	let contribution = reviewContribution("none", { answerer: "codex", ending: "error" });
	assert.equal(contribution, "none");
	contribution = reviewContribution(contribution, { answerer: "codex", ending: "aborted" });
	assert.equal(contribution, "none");
	for (const ending of ["pending", "stop", "length", "toolUse", "deferred"] as const) {
		assert.equal(reviewContribution("none", { answerer: "codex", ending }), "codex", ending);
	}
	contribution = reviewContribution(contribution, { answerer: "codex", ending: "toolUse" });
	assert.equal(contribution, "codex");
	assert.equal(reviewContribution(contribution, { answerer: "copilot", ending: "stop" }), "codex");
}

function authority() {
	const input = { version: 1, accountOrder: ["work", "personal"], copilotProfile: "work", work: { githubOwners: ["example-org"], roots: ["/synthetic/root"] }, review: { copilotModel: primary.id, codexFallbackModel: fallback.id } };
	const policy = parsePolicy(input);
	input.accountOrder.reverse();
	input.work.githubOwners[0] = "changed";
	input.work.roots[0] = "/changed";
	input.review.codexFallbackModel = "changed";
	assert.deepEqual(policy.codexOrder, [WORK_ACCOUNT, PERSONAL_ACCOUNT]);
	const workProfile = policy.profiles.find(profile => profile.name === "work");
	assert.ok(workProfile && workProfile.name === "work");
	assert.deepEqual(workProfile.criteria, { githubOwners: ["example-org"], roots: ["/synthetic/root"] });
	assert.equal(policy.review?.fallback, fallback.id);
	assert.throws(() => Object.assign(policy.review!, { fallback: codexModelId("changed") }), TypeError);
	assert.throws(() => Object.assign(policy, { codexOrder: [PERSONAL_ACCOUNT] }), TypeError);
	assert.throws(() => Array.prototype.push.call(policy.codexOrder, WORK_ACCOUNT), TypeError);
	for (const value of [policy, policy.review, policy.profiles, policy.codexOrder, ...policy.profiles, ...policy.profiles.map(profile => profile.accounts)]) assert.ok(Object.isFrozen(value));
	for (const name of ["Attempt", "RetryableQuota", "ProviderQuota", "OrderedPlan", "finish", "routing", "planReview", "planCodex"]) assert.equal(name in routingAPI, false, name);
	for (const name of ["BoundReview", "ParsedPolicy"]) assert.equal(name in policyAPI, false, name);
	const directory = join(getAgentDir(), "unrelated-budget");
	mkdirSync(directory);
	writeFileSync(join(directory, "copilot-review.bad.json"), "{}");
	writeFileSync(join(directory, "work-codex.bad.json"), "{}");
	assert.deepEqual([...createQuotaLedger(directory, assert.fail).snapshot([personal], Date.now())], [["personal-codex", { kind: "available" }]]);
}

async function authScope(ctx: ExtensionContext) {
	const { root, cwd } = eligibleCheckout();
	let bootstrapCalls = 0;
	const denyNative = () => { bootstrapCalls++; assert.fail("Bootstrap discovery must not authorize native credentials or requests"); };
	const bootstrapAuth = {
		apiKey: { name: "Fixture", async check() { return { type: "api_key" as const, source: "fixture" }; }, resolve: denyNative },
		oauth: { ...codex.auth.oauth!, refresh: denyNative, toAuth: denyNative },
	};
	const bootstrapPolicy = parsePolicy({ version: 1, accountOrder: ["work", "personal"], copilotProfile: "work", work: { roots: [root] } });
	const bootstrap = routingFixture(
		{ ...codex, auth: bootstrapAuth, stream: denyNative, streamSimple: denyNative },
		{ ...copilot, auth: bootstrapAuth, stream: denyNative, streamSimple: denyNative, classify: denyNative },
		() => undefined, createQuotaLedger(join(getAgentDir(), "bootstrap-scope"), assert.fail), assert.fail, bootstrapPolicy, () => cwd,
	);
	const authInput = { ctx: { async env() { return undefined; }, async fileExists() { return false; } }, signal: new AbortController().signal };
	const credential = { type: "oauth" as const, access: "fake", refresh: "fake", expires: 4102444800000 };
	for (const provider of [bootstrap.work, bootstrap.copilot]) {
		assert.deepEqual(provider.filterModels!(provider.getModels(), undefined), provider.getModels());
		assert.deepEqual(await provider.auth.apiKey!.check!(authInput), { type: "api_key", source: "fixture" });
		await assert.rejects(() => provider.auth.apiKey!.resolve(authInput), /restricted/);
		await assert.rejects(() => provider.auth.oauth!.toAuth(credential), /restricted/);
		assert.throws(() => provider.auth.oauth!.refresh(credential, authInput.signal), /restricted/);
	}
	const transcript = normalizeContext({ messages: [] });
	for (const callback of [bootstrap.work.stream, bootstrap.work.streamSimple]) {
		const denied = await callback(fallback, transcript, { apiKey: "fake-explicit" }).result();
		assert.equal(denied.stopReason, "error");
		assert.match(denied.errorMessage!, /restricted/);
	}
	assert.throws(() => bootstrap.copilot.streamSimple(primary, transcript, { apiKey: "fake-explicit" }), /restricted/);
	const classification = await bootstrap.copilot.classify!(primary, { state: {}, questions: {} }, { apiKey: "fake-explicit" });
	assert.equal(classification.stopReason, "error");
	assert.match(classification.errorMessage!, /restricted/);
	assert.equal(bootstrapCalls, 0);
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
	const routing = routingFixture(native, copilot, () => current, createQuotaLedger(join(getAgentDir(), "auth-scope"), assert.fail), assert.fail, policy);
	const stream = routing.personal.streamSimple({ ...fallback, provider: "openai-codex:personal" }, normalizeContext({ messages: [] }), { apiKey: "fake-source" });
	await started;
	current = { ...current, cwd: outside };
	release();
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /Repository changed/);
	assert.equal(calls, 0);
	assert.equal(authCalls, 1);
	const workProvider = routing.work;
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
		const guarded = routingFixture(wrapped, copilot, () => current, createQuotaLedger(join(getAgentDir(), `oauth-${operation}`), assert.fail), assert.fail, policy).work.auth.oauth!;
		const credential: Parameters<typeof oauth.refresh>[0] = { type: "oauth", access: "fake", refresh: "fake", expires: Date.now() + 60000 };
		if (operation === "refresh") assert.equal(await guarded.refresh(credential, new AbortController().signal), credential, "Allowed refresh returns the credential for native persistence despite scope loss");
		await assert.rejects(() => guarded.toAuth(credential), /restricted/);
		assert.equal(nativeCalls, 1, `${operation} cannot authorize work auth after scope loss`);
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
	const snapshotNative: typeof codex = { ...codex, streamSimple(model, _transcript, options = {}) {
		calls++;
		const output = createAssistantMessageEventStream();
		(async () => {
			for (const event of [{ type: "response.created" }, { type: "response.in_progress" }]) {
				await options.onPayload?.({}, model);
				await options.onProviderStreamEvent?.(event, model);
			}
			output.push({ type: "done", reason: "stop", message: { ...message(model), stopReason: "stop" } });
			output.end();
		})();
		return output;
	} };
	const changed = routingFixture(snapshotNative, copilot, () => current, createQuotaLedger(join(getAgentDir(), "auth-root"), assert.fail), assert.fail, aliasPolicy);
	const completed = await changed.personal.streamSimple({ ...fallback, provider: "openai-codex:personal" }, normalizeContext({ messages: [] })).result();
	assert.equal(completed.stopReason, "stop", completed.errorMessage);
	assert.equal(calls, 1, "the request keeps its initial repository membership through auth and stream callbacks");
	const denied = await changed.work.streamSimple(fallback, normalizeContext({ messages: [] })).result();
	assert.equal(denied.stopReason, "error");
	assert.match(denied.errorMessage!, /restricted/);
	assert.equal(calls, 1, "the next request resolves repository membership again");
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
	const native: ReturnType<typeof openaiCodexProvider> = { ...codex,
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
	const options = { apiKey: "fake-source", headers: { "source-only": "retained" }, env: { SOURCE: "retained" } };
	for (const current of [() => ({ ...ctx, modelRegistry: registry }), () => undefined]) {
		const { personal: provider } = routingFixture(native, copilot, current, createQuotaLedger(join(getAgentDir(), "direct-source"), assert.fail), assert.fail, policy);
		const raw = await provider.stream(source, normalizeContext({ messages: [] }), { ...options, reasoningEffort: "high", toolChoice: "required" }).result();
		const simple = await provider.streamSimple(source, normalizeContext({ messages: [] }), { ...options, reasoning: "high" }).result();
		for (const result of [raw, simple]) { assert.equal(result.stopReason, "stop"); assert.equal(result.model, source.id); }
		const invalid = await provider.streamSimple({ ...source, id: "" }, normalizeContext({ messages: [] }), options).result();
		assert.equal(invalid.stopReason, "error", "rejected native input returns a terminal stream");
	}
	assert.equal(calls, 4);
	let current: ExtensionContext | undefined = ctx;
	const detached: typeof codex = { ...codex, streamSimple(model) { current = undefined; return complete(model); } };
	const routing = routingFixture(detached, copilot, () => current, createQuotaLedger(join(getAgentDir(), "personal-detached"), assert.fail), assert.fail, policy);
	const result = await routing.personal.streamSimple(source, normalizeContext({ messages: [] }), options).result();
	assert.equal(result.stopReason, "stop", "personal streams do not require a bound work repository after request start");
}

async function attemptTransition(ctx: ExtensionContext) {
	const mode = process.env.DOMAIN_MODE!;
	const { root, cwd } = eligibleCheckout();
	const last = mode === "last-internal-quota";
	const policy = parsePolicy({ version: 1, accountOrder: last ? ["personal"] : ["work", "personal"], work: { roots: [root] } });
	const calls: string[] = [];
	const observed: DirectObservation[] = [];
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
					if (mode === "raw-text-delta" || mode === "mutated-text-delta") await options.onProviderStreamEvent?.({ type: "response.output_text.delta", delta: "received output" }, model);
					if (mode === "raw-output-item") await options.onProviderStreamEvent?.({ type: "response.output_item.added", item: { type: "reasoning", encrypted_content: "opaque" } }, model);
					if (mode === "raw-cost") await options.onProviderStreamEvent?.({ response: { usage: { cost: { total: 0.1 } } } }, model);
					await options.onProviderStreamEvent?.(quotaEvent, model);
					if (mode === "repeated-quota") await options.onProviderStreamEvent?.(quotaEvent, model);
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
	const routing = routingFixture({ ...codex, streamSimple }, copilot, () => ({ ...registryContext(ctx), cwd }), ledger, assert.fail, policy);
	const account = last || mode === "cleanup-caller-abort" ? "personal" : "work";
	const stream = routing[account].streamSimple({ ...fallback, provider: `openai-codex:${account}` }, normalizeContext({ messages: [] }), {
		apiKey: "fake-source", signal: caller.signal,
		maxRetries: ["internal-quota", "last-internal-quota", "caller-and-internal"].includes(mode) ? 3 : 0,
		onResponse() { if (mode === "hook-before-quota" || mode === "hook-after-quota") throw new Error("fixture response hook failed"); },
		onProviderStreamEvent(event) {
			if (mode === "mutated-text-delta" && event && typeof event === "object") Object.assign(event, { type: "response.created", delta: "" });
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
		const snapshot = quota.snapshot([personal, work, review], Date.now());
		assert.equal(snapshot.get(proof.account.budget)!.kind, "cooling", "quota persists independently of retry permission");
	}
	return { calls, stopReason: result.stopReason, provider: result.provider, observations: observed.map(proof => proof.account), callerAborted: caller.signal.aborted, usage: result.usage };
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
