import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, isModelType, normalizeContext, type AssistantMessage, type Model, type Api, type Provider, type StreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nativeProviders } from "../native-guards.ts";
import { parsePolicy } from "../policy.ts";
import { createQuotaLedger, type QuotaLedger } from "../quota.ts";
import type { DirectObservation } from "../quota-protocol.ts";
import { routingFixture } from "./routing-fixture.ts";
import { reviewModel } from "../review.ts";

const { codex, copilot } = nativeProviders();
const primary = copilot.getModels().find(model => model.id === "claude-sonnet-5.5")!;
const fallback = codex.getModels().find(model => model.id === "gpt-5.6-luna")!;
const transcript = normalizeContext({ messages: [] });
function message(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function success(model: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message: message(model, "stop") });
	stream.end();
	return stream;
}
function fixture(ctx: ExtensionContext, mismatch = false) {
	const root = join(getAgentDir(), "repositories");
	const cwd = join(root, "checkout");
	mkdirSync(cwd, { recursive: true });
	execFileSync("git", ["-C", cwd, "init", "-q"]);
	const policy = parsePolicy({ version: 1, accountOrder: ["personal"], copilotProfile: "work", work: { roots: [root] }, review: { copilotModel: primary.id, codexFallbackModel: fallback.id } });
	assert.ok(policy.review);
	const advertised = reviewModel(policy.review, primary, fallback);
	let authCalls = 0;
	let snapshots = 0;
	const observations: DirectObservation[] = [];
	const stored = createQuotaLedger(join(getAgentDir(), "quota"), assert.fail);
	const quota: QuotaLedger = {
		snapshot(candidates, nowMs) { snapshots++; return stored.snapshot(candidates, nowMs); },
		observeDirect(observation) { observations.push(observation); stored.observeDirect(observation); },
	};
	const find: ExtensionContext["modelRegistry"]["find"] = (provider, id) => {
		if (provider === "profile-review") return id === primary.id ? advertised : undefined;
		const model = (provider === "github-copilot" ? copilot : codex).getModels().find(model => model.id === id);
		if (!model) return undefined;
		return { ...model, provider, ...(mismatch && provider === "openai-codex:personal" ? { inputLimits: { maxRequestBytes: 1234 } } : {}) };
	};
	const auth: ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"] = async () => { authCalls++; return { ok: true, apiKey: "fixture-destination" }; };
	const registry = new Proxy(ctx.modelRegistry, { get(target, key, receiver) {
		if (key === "find") return find;
		if (key === "getApiKeyAndHeaders") return auth;
		return Reflect.get(target, key, receiver);
	} });
	return { policy, advertised, quota, observations, ctx: { ...ctx, cwd, modelRegistry: registry }, counts: () => ({ authCalls, snapshots }) };
}

async function reviewOwnership(ctx: ExtensionContext) {
	for (const mode of ["outside", "unknown", "unowned", "stale", "mismatch", "eligible"]) {
		const data = fixture(ctx, mode === "mismatch");
		let current: ExtensionContext | undefined = mode === "unknown" ? undefined : { ...data.ctx, ...(mode === "outside" ? { cwd: getAgentDir() } : {}) };
		const policy = mode === "unowned" ? parsePolicy({ version: 1, accountOrder: ["personal"], review: { copilotModel: primary.id, codexFallbackModel: fallback.id } }) : data.policy;
		let sends = 0;
		const native: typeof copilot = { ...copilot, streamSimple(model, _transcript, options) { sends++; assert.equal(options?.apiKey, "fixture-destination"); return success(model); } };
		const routing = routingFixture(codex, native, () => current, data.quota, assert.fail, policy);
		if (["outside", "unknown", "unowned", "mismatch"].includes(mode)) {
			assert.deepEqual(routing.review.filterModels!(routing.review.getModels(), undefined), []);
			assert.equal(await routing.review.auth.apiKey!.check!({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal }), undefined);
		}
		const source = mode === "stale" ? { ...data.advertised, id: "stale-exact-review" } : data.advertised;
		const result = await routing.review.streamSimple(source, transcript, { apiKey: "fixture-caller-must-not-authorize" }).result();
		if (mode === "eligible") {
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(result.provider, "github-copilot");
			assert.equal(sends, 1);
			assert.deepEqual(data.counts(), { authCalls: 1, snapshots: 1 });
		} else {
			assert.equal(result.stopReason, "error", mode);
			assert.equal(sends, 0, mode);
			assert.deepEqual(data.counts(), { authCalls: 0, snapshots: 0 }, "Review denial and capability checks precede budgets and physical auth");
		}
		current = undefined;
	}
}

async function directCopilot(ctx: ExtensionContext) {
	const source = { ...primary, provider: "openai-codex:work" };
	const controller = new AbortController();
	const headers = { "fixture-request": "preserved" };
	const env = { FIXTURE: "preserved" };
	const sentinel = success(primary);
	let calls = 0;
	const inspect = (model: Model<Api>, options: StreamOptions | undefined) => {
		calls++;
		assert.equal(model.provider, "github-copilot");
		assert.equal(options?.signal, controller.signal);
		assert.equal(options?.headers, headers);
		assert.equal(options?.env, env);
		assert.equal(options?.apiKey, "fixture-source");
		assert.equal(Object.hasOwn(options!, "maxRetries"), false);
	};
	const native: typeof copilot = {
		...copilot,
		stream(model, _transcript, options) { inspect(model, options); assert.equal(options && "thinkingEnabled" in options && options.thinkingEnabled, true); return sentinel; },
		streamSimple(model, _transcript, options) { inspect(model, options); assert.equal(options?.reasoning, "high"); return sentinel; },
	};
	const policy = parsePolicy({ version: 1, accountOrder: ["personal"], copilotProfile: "personal" });
	const quota: QuotaLedger = { snapshot() { assert.fail("ordinary Copilot read routed quota"); }, observeDirect() { assert.fail("ordinary Copilot wrote routed quota"); } };
	const routing = routingFixture(codex, native, () => ctx, quota, assert.fail, policy);
	const options = { signal: controller.signal, headers, env, apiKey: "fixture-source" };
	assert.equal(routing.copilot.streamSimple(source, transcript, { ...options, reasoning: "high" }), sentinel);
	assert.equal(routing.copilot.stream(source, transcript, { ...options, thinkingEnabled: true }), sentinel);
	assert.equal(calls, 2);
	const classifier = copilot.getAllModels!().find(model => isModelType(model, "classifier"));
	assert.ok(classifier && isModelType(classifier, "classifier"));
	const result = { api: classifier.api, provider: classifier.provider, model: classifier.id, answers: {}, stopReason: "stop" as const, timestamp: 1 };
	const classifierNative: typeof copilot = { ...copilot, async classify(_model, _context, received) {
		assert.equal(received?.signal, controller.signal);
		assert.equal(Object.hasOwn(received!, "maxRetries"), false);
		return result;
	} };
	const guarded = routingFixture(codex, classifierNative, () => ctx, quota, assert.fail, policy);
	assert.equal(await guarded.copilot.classify!(classifier, { state: { fixture: true }, questions: {} }, options), result);
}

async function receiptAndClosure(ctx: ExtensionContext, mode: string) {
	const data = fixture(ctx);
	let current = data.ctx;
	let closed = false;
	let calls = 0;
	let notices = 0;
	const native: typeof copilot = { ...copilot, streamSimple(model, _transcript, options = {}) {
		calls++;
		const stream = createAssistantMessageEventStream();
		Object.defineProperty(stream, Symbol.asyncIterator, { value: async function* () {
			try {
				if (mode === "hook-before-http-quota") { try { await options.onResponse?.({ status: 200, headers: {} }, model); } catch {} }
				try {
					await options.fetch!("https://fixture.invalid/quota");
					if (mode === "event-receipt-scope") {
						current = { ...data.ctx, cwd: getAgentDir() };
						await options.onProviderStreamEvent?.({ response: { usage: { input_tokens: 2 }, output: [{ type: "reasoning", encrypted_content: "fixture" }] } }, model);
					}
				} catch { current = data.ctx; }
				yield { type: "error", reason: "error", error: message(model) } as const;
			} finally {
				await Promise.resolve();
				closed = true;
				if (mode === "cleanup-failure") throw new Error("fixture iterator cleanup failed");
				if (mode === "cleanup-scope") current = { ...data.ctx, cwd: getAgentDir() };
			}
		} });
		return stream;
	} };
	const fallbackNative: typeof codex = { ...codex, streamSimple(model) { calls++; assert.equal(closed, true, "Fallback started before iterator closure"); return success(model); } };
	const routing = routingFixture(fallbackNative, native, () => current, data.quota, () => { notices++; }, data.policy);
	const result = await routing.review.streamSimple(data.advertised, transcript, {
		onResponse() { if (mode === "hook-before-http-quota") throw new Error("fixture caller hook failed"); },
		async fetch() {
			if (mode === "http-receipt-scope") current = { ...data.ctx, cwd: getAgentDir() };
			return new Response(JSON.stringify({ error: { code: "quota_exceeded" } }), { status: 402 });
		},
	}).result();
	assert.equal(closed, true);
	assert.equal(data.observations.length, 1, "Returned quota response must be recorded before post-response denial");
	assert.equal(data.observations[0].account.credential, "github-copilot");
	assert.equal(calls, mode === "cleanup-awaited" ? 2 : 1, mode);
	assert.equal(result.stopReason, mode === "cleanup-awaited" ? "stop" : "error", result.errorMessage);
	assert.equal(notices, mode === "cleanup-awaited" ? 1 : 0, "Policy and callback failures are not quota fallback notices");
}

export default function (pi: ExtensionAPI) {
	globalThis.fetch = async () => { assert.fail("Boundary fixture attempted external fetch"); };
	pi.on("session_start", async (_event, ctx) => {
		try {
			const kind = process.env.DOMAIN_CASE!;
			if (kind === "review-ownership") await reviewOwnership(ctx);
			else if (kind === "direct-copilot") await directCopilot(ctx);
			else await receiptAndClosure(ctx, kind);
			pi.appendEntry("domain-probe", { passed: kind });
		} catch (error) { pi.appendEntry("domain-probe", { error: String(error), stack: error instanceof Error ? error.stack : "" }); }
	});
}
