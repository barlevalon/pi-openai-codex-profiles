import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { nativeProviders } from "../native-guards.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { reviewModel } from "../review.ts";
import { parsePolicy } from "../policy.ts";
import { createQuotaLedger } from "../quota.ts";
import { routingFixture } from "./routing-fixture.ts";

export async function reviewFixtures(ctx) {

	const codex = nativeProviders().codex;
	const copilot = nativeProviders().copilot;
	const config = { copilotModel: "claude-sonnet-5.5", codexFallbackModel: "gpt-5.6-luna" };
	const binding = parsePolicy({ version: 1, copilotProfile: "personal", accountOrder: ["personal"], review: config }).review;
	const primary = copilot.getModels().find(model => model.id === config.copilotModel)!;
	const fallback = codex.getModels().find(model => model.id === config.codexFallbackModel)!;
	assert.doesNotThrow(() => reviewModel(binding, { ...primary, inputLimits: undefined }, fallback));
	assert.doesNotThrow(() => reviewModel(binding, { ...primary, inputLimits: { images: { resize: { maxWidth: 2000 } } } }, fallback));
	assert.doesNotThrow(() => reviewModel(binding, primary, { ...fallback, inputLimits: undefined }, reviewModel(binding, primary, fallback)));
	for (const inputLimits of [{ maxRequestBytes: 1024 }, { images: { maxPerMessage: 2 } }, { images: { resize: { maxWidth: 1234 } } }]) {
		assert.throws(() => reviewModel(binding, { ...primary, inputLimits }, fallback), /incompatible/);
	}
	assert.throws(() => reviewModel(binding, { ...primary, input: ["image"] }, fallback), /incompatible/);
	assert.throws(() => reviewModel(binding, { ...primary, type: "image" }, fallback), /unavailable/);
	assert.throws(() => reviewModel(binding, undefined, fallback), /unavailable/);
	assert.throws(() => reviewModel(binding, primary, { ...fallback, id: "neighbor-model" }), /unavailable/);
	let authCalls = 0;
	const current = { ...ctx, modelRegistry: { find: (...args) => ctx.modelRegistry.find(...args), getApiKeyAndHeaders() { authCalls++; assert.fail("invalid review resolved physical auth"); } } };
	for (const mode of ["disabled", "missing-native", "work-mismatch"]) {
		const policy = parsePolicy({ version: 1, copilotProfile: "personal", accountOrder: ["work", "personal"], work: { githubOwners: ["example-org"] }, ...(mode === "disabled" ? {} : { review: config }) });
		const registry = mode === "work-mismatch" ? { ...current.modelRegistry, find(provider, id) {
			const model = ctx.modelRegistry.find(provider, id);
			return provider === "openai-codex:work" ? { ...model, inputLimits: { maxRequestBytes: 1234 } } : model;
		} } : current.modelRegistry;
		const routing = routingFixture(mode === "missing-native" ? { ...codex, getModels: () => [] } : codex, copilot, () => ({ ...current, modelRegistry: registry }), createQuotaLedger(join(getAgentDir(), `review-${mode}`), assert.fail), assert.fail, policy);
		if (mode === "disabled") { assert.equal(routing.review.getModels().length, 0); continue; }
		if (mode === "missing-native") {
			assert.ok(routing.unavailableReview);
			assert.throws(() => routing.unavailableReview.route({}), /unavailable/);
			continue;
		}
		assert.equal(routing.review.getModels().length, 1);
		const stream = routing.review.streamSimple({ ...primary, provider: "profile-review" }, { messages: [] }, { apiKey: "fake", fetch: () => assert.fail("invalid review sent a request") });
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		assert.equal(result.stopReason, "error", mode);
		assert.match(result.errorMessage, /not configured|unavailable|incompatible/, mode);
		assert.equal(events.length, 1, mode);
	}
	assert.equal(authCalls, 0);

	const otherCodex = codex.getModels().find(model => model.id !== fallback.id && JSON.stringify(model.inputLimits) === JSON.stringify(fallback.inputLimits));
	assert.ok(otherCodex, "the native catalog supplies a second representative Codex model");
	const alternate = { ...config, codexFallbackModel: otherCodex.id };
	const alternatePolicy = parsePolicy({ version: 1, copilotProfile: "personal", accountOrder: ["personal"], review: alternate });
	const advertised = reviewModel(alternatePolicy.review, primary, otherCodex);
	const quota = createQuotaLedger(join(getAgentDir(), "review-alternate"), assert.fail);
	const raw = { ...codex, streamSimple(model) {
		return (async function* () {
			yield { type: "done", reason: "stop", message: {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			} };
		})();
	} };
	const registry = {
		find: (provider, id) => provider === "profile-review" && id === primary.id ? advertised : ctx.modelRegistry.find(provider, id),
		async getApiKeyAndHeaders() { return { ok: true, apiKey: "fake" }; },
	};
	const routing = routingFixture(raw, copilot, () => ({ ...ctx, modelRegistry: registry }), quota, () => {}, alternatePolicy);
	const normalResult = await routing.personal.streamSimple(registry.find("openai-codex:personal", otherCodex.id), { messages: [] }).result();
	assert.equal(normalResult.stopReason, "stop", normalResult.errorMessage);
	assert.equal(normalResult.provider, "openai-codex:personal");
	assert.equal(normalResult.model, otherCodex.id, "normal account routing preserves the selected native model ID");
	mkdirSync(join(getAgentDir(), "review-alternate"), { recursive: true });
	writeFileSync(join(getAgentDir(), "review-alternate", "copilot-review.fixture.json"), JSON.stringify({ version: 1, key: "copilot-review", until: Date.now() + 60000 }));
	assert.equal(routing.review.getModels().length, 1);
	const fallbackResult = await routing.review.streamSimple(advertised, { messages: [] }).result();
	assert.equal(fallbackResult.stopReason, "stop", fallbackResult.errorMessage);
	assert.equal(fallbackResult.provider, "openai-codex:personal");
	assert.equal(fallbackResult.model, otherCodex.id, "review uses the exact configured fallback instead of a default");
}
