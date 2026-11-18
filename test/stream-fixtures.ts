import assert from "node:assert/strict";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createQuotaLedger } from "../quota.ts";
import { createNativeRouting } from "../routing.ts";
import { loadPolicy } from "../policy.ts";

export async function streamFixtures(ctx) {
	const native = builtinProviders().find(provider => provider.id === "openai-codex")!;
	const source = ctx.modelRegistry.find("openai-codex:work", "gpt-5.6-luna");
	for (const mode of ["mutation", "usage", "raw-content", "hook-mutation", "provider-abort", "malformed", "scope-change", "scope-response", "scope-event", "scope-fetch", "scope-fetch-entry", "unbound"]) {
		let current = ctx;
		let sends = 0;
		let networkSends = 0;
		const calls = [];
		const raw = {
			...native,
			streamSimple(model, _transcript, options) {
				calls.push({ provider: model.provider, options });
				return (async function* () {
					const message = {
						role: "assistant", api: model.api, provider: model.provider, model: model.id,
						content: [], stopReason: "pending", timestamp: Date.now(),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					};
					await options.onPayload?.({}, model);
					if (mode === "scope-response") await options.onResponse?.({ status: 200, headers: {} }, model);
					if (mode === "scope-event") await options.onProviderStreamEvent?.({ type: "error", error: { code: "usage_limit_reached" } }, model);
					if (mode === "scope-fetch-entry") current = { ...ctx, cwd: getAgentDir() };
					if (mode === "scope-fetch" || mode === "scope-fetch-entry") await options.fetch("http://127.0.0.1:1/fixture", {});
					sends++;
					yield { type: "start", partial: message };
					if (mode === "mutation" || mode === "malformed") {
						message.content.push({ type: "text", text: "a" });
						yield { type: "text_delta", contentIndex: 0, delta: "a", partial: message };
						message.content[0].text = "ab";
					}
					if (mode === "usage") message.usage.input = 2;
					if (mode === "raw-content") await options.onProviderStreamEvent?.({ type: "response.failed", response: { output: [{ type: "reasoning", encrypted_content: "opaque" }] } }, model);
					if (mode !== "mutation") {
						await options.onProviderStreamEvent?.({ type: "error", error: { code: mode === "hook-mutation" ? "rate_limit_exceeded" : "usage_limit_reached" } }, model);
						message.stopReason = mode === "provider-abort" ? "aborted" : "error";
						if (mode === "malformed") throw new Error("fixture stream broke");
						yield { type: "error", reason: message.stopReason, error: message };
					} else {
						message.stopReason = "stop";
						yield { type: "done", reason: "stop", message };
					}
				})();
			},
		};
		const routing = createNativeRouting(raw, raw, () => current, createQuotaLedger(join(getAgentDir(), `stream-${mode}`), assert.fail), assert.fail, loadPolicy(getAgentDir(), assert.fail));
		if (mode === "unbound") {
			current = undefined;
			const result = await routing.accountProvider("work").streamSimple({ ...source, provider: "openai-codex:personal" }, { messages: [] }, { apiKey: "fake" }).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage, /restricted/);
			continue;
		}
		const stream = routing.accountProvider("work").streamSimple(source, { messages: [] }, {
			apiKey: "fake", transport: "auto", reasoning: "high",
			onPayload() { if (mode === "scope-change") current = { ...ctx, cwd: getAgentDir() }; },
			async onResponse() { await Promise.resolve(); if (mode === "scope-response") current = { ...ctx, cwd: getAgentDir() }; },
			async onProviderStreamEvent(event) {
				await Promise.resolve();
				if (mode === "hook-mutation") event.error.code = "usage_limit_reached";
				if (mode === "scope-event") current = { ...ctx, cwd: getAgentDir() };
			},
			async fetch() {
				networkSends++;
				await Promise.resolve();
				if (mode === "scope-fetch") current = { ...ctx, cwd: getAgentDir() };
				return new Response(JSON.stringify({ error: { code: "usage_limit_reached" } }), { status: 429 });
			},
		});
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		assert.equal(calls.length, 1, mode);
		assert.equal(calls[0].options.transport, "auto", "caller transport is not forced to SSE");
		assert.equal(calls[0].options.reasoning, "high");
		assert.equal(events.filter(event => ["done", "error"].includes(event.type)).length, 1, mode);
		if (mode === "mutation" || mode === "malformed") {
			assert.equal(events[0].partial.content.length, 0, "later provider mutations cannot alter exposed start");
			assert.equal(events[1].partial.content[0].text, "a");
			assert.equal(result.content[0].text, mode === "malformed" ? "a" : "ab");
		}
		if (mode === "usage") assert.equal(result.usage.input, 2);
		if (mode === "provider-abort") assert.equal(result.stopReason, "aborted");
		if (mode.startsWith("scope-")) {
			assert.equal(result.stopReason, "error", mode);
			assert.equal(sends, 0, "scope is rechecked after asynchronous caller hooks and fetch");
			assert.equal(networkSends, mode === "scope-fetch" ? 1 : 0, "send entry requires current authorization");
		}
	}
}
