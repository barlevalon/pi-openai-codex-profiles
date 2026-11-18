import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { streamFixtures } from "./stream-fixtures.ts";
import { reviewFixtures } from "./review-fixtures.ts";

export default function (pi) {
	const scenario = JSON.parse(process.env.ROUTING_SCENARIO!);
	const requests = [];
	let external = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (!url.startsWith("http://127.0.0.1:")) {
			external++;
			throw new Error("Test blocked external fetch");
		}
		return originalFetch(input, init);
	};
	pi.on("session_start", async (_event, ctx) => {
		try {
			assert.equal(ctx.model.provider, scenario.review ? "profile-review" : "codex-policy");
			assert.equal(ctx.model.id, scenario.review ? scenario.reviewId ?? "claude-sonnet-5.5" : "gpt-5.6-luna");
			assert.equal(pi.getThinkingLevel(), scenario.thinking ?? "high");
			if (scenario.policy === "missing" || scenario.policy === "malformed" || (scenario.policy && typeof scenario.policy === "object" && !scenario.policy.review)) assert.equal(ctx.modelRegistry.getAll().some(model => model.provider === "profile-review"), false, "no policy means no implicit review ID");
			const before = readFileSync(join(getAgentDir(), "auth.json"), "utf8");
			if (scenario.snapshot) writeFileSync(join(getAgentDir(), "codex-routing-policy.json"), JSON.stringify({ version: 1, accountOrder: ["personal"] }));
			if (scenario.catalogOnly) {
				const primary = ctx.modelRegistry.find("github-copilot", scenario.reviewId ?? "claude-sonnet-5.5");
				const fallback = ctx.modelRegistry.find("openai-codex:personal", "gpt-5.6-luna");
				assert.equal(ctx.model.contextWindow, Math.min(primary.contextWindow, fallback.contextWindow));
				assert.equal(ctx.model.maxTokens, Math.min(primary.maxTokens, fallback.maxTokens));
				assert.deepEqual(ctx.model.input, primary.input.filter(kind => fallback.input.includes(kind)));
				assert.deepEqual(getSupportedThinkingLevels(ctx.model), getSupportedThinkingLevels(primary).filter(level => getSupportedThinkingLevels(fallback).includes(level)));
				assert.deepEqual(ctx.model.inputLimits, primary.inputLimits);
				pi.appendEntry("routing-probe-ready", { model: ctx.model.provider, external });
				return;
			}
			if (scenario.staleReview) {
				const stream = ctx.modelRegistry.getProvider("profile-review").streamSimple({ ...ctx.model, id: "stale-review-id" }, { messages: [] }, { apiKey: "fake", fetch: () => assert.fail("stale review reached physical transport") });
				const result = await stream.result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage, /not configured/);
			}
			if (scenario.select) {
				await pi.setModel(ctx.modelRegistry.find(scenario.select, "gpt-5.6-luna"));
				assert.equal(ctx.model.provider, "codex-policy");
			}
			if (scenario.guard) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.modelRegistry.find("openai-codex:work", "gpt-5.6-luna"));
				assert.equal(auth.ok, false);
				assert.match(auth.error, /restricted/);
				const model = ctx.modelRegistry.find("openai-codex:work", "gpt-5.6-luna");
				const stream = ctx.modelRegistry.streamSimple(model, { messages: [] }, { apiKey: scenario.workToken, headers: { Authorization: "explicit" }, transport: "sse", fetch: () => { throw new Error("Work transport reached"); } });
				const result = await stream.result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage, /restricted/);
				const physical = ctx.modelRegistry.getProvider("openai-codex:work");
				const direct = physical.streamSimple({ ...model, headers: { Authorization: "explicit-model-header" } }, { messages: [] }, { apiKey: scenario.workToken, headers: { Authorization: "explicit-option-header" }, transport: "sse", fetch: () => { throw new Error("Work raw transport reached"); } });
				const denied = await direct.result();
				assert.equal(denied.stopReason, "error");
				assert.match(denied.errorMessage, /restricted/);
			}
			if (scenario.synthetic) {
				await streamFixtures(ctx);
				await reviewFixtures(ctx);
				pi.appendEntry("routing-probe-ready", { model: ctx.model.provider, external });
				return;
			}
			if (scenario.capabilityCheck) {
				const registry = ctx.modelRegistry;
				const resolve = registry.getApiKeyAndHeaders;
				let authCalls = 0;
				registry.getApiKeyAndHeaders = () => { authCalls++; assert.fail("invalid review resolved physical auth"); };
				try {
					const stream = registry.getProvider("profile-review").streamSimple(ctx.model, { messages: [] }, { apiKey: "fake", fetch: () => assert.fail("invalid review sent a request") });
					const events = [];
					for await (const event of stream) events.push(event);
					const result = await stream.result();
					assert.equal(authCalls, 0);
					assert.equal(result.stopReason, "error");
					assert.match(result.errorMessage, /incompatible capabilities/);
					assert.equal(events.length, 1);
				} finally { registry.getApiKeyAndHeaders = resolve; }
			} else if (!scenario.agent) {
				const controller = new AbortController();
				const rawEvents = [];
				const responses = [];
				const payloads = [];
				const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
				const quota = { type: "error", error: { code: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 600 } };
				const complete = { type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 } } };
				const options = {
					transport: "sse", reasoning: scenario.thinking ?? "high", signal: controller.signal, maxRetries: scenario.retries ?? 0,
					...(scenario.raw ? { reasoningEffort: scenario.thinking ?? "high", textVerbosity: "high", toolChoice: "required" } : {}),
					headers: { "source-only": "must-not-cross" },
					onPayload(payload, model) { payloads.push({ payload, provider: model.provider }); },
					onResponse(response, model) {
						responses.push({ status: response.status, provider: model.provider });
						if (scenario.mode === "hook") throw new Error("fixture hook failed");
					},
					onProviderStreamEvent(event, model) {
						rawEvents.push({ event, provider: model.provider });
						if (scenario.mode === "abort" && event.type === "error") controller.abort();
						if (scenario.mode === "event-hook" && event.type === "error") throw new Error("fixture event hook failed");
					},
					fetch: async (input, init) => {
						const headers = Object.fromEntries(new Headers(init.headers));
						requests.push({ url: String(input), headers });
						const work = headers["chatgpt-account-id"] === "work";
						if (scenario.personalQuota && headers["chatgpt-account-id"] === "personal") return scenario.mode === "http" ? new Response(JSON.stringify(quota), { status: 429 }) : sse([quota]);
						if (scenario.reviewError && headers["chatgpt-account-id"] === "personal") return new Response("fixture failure", { status: 500 });
						const copilot = String(input).includes("/copilot/");
						if (copilot) {
							if (scenario.mode === "copilot-rate") return new Response(JSON.stringify({ error: { code: "quota_exceeded" } }), { status: 429 });
							if (scenario.mode === "copilot-ok" && scenario.reviewId === "gpt-5.6-luna") return sse([complete]);
							if (scenario.mode === "copilot-ok") return new Response([
								'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-5.5","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
								'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
								'event: message_stop\ndata: {"type":"message_stop"}\n\n',
							].join(""), { headers: { "content-type": "text/event-stream" } });
							return new Response(JSON.stringify({ error: { message: "You have no quota", code: "quota_exceeded" } }), { status: 402, headers: { "retry-after": "60" } });
						}
						if (work && scenario.mode !== "success" && scenario.mode !== "empty") {
							if (scenario.mode === "unauthorized") return new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 });
							if (scenario.mode === "rate") return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "quota exhausted" } }), { status: 429 });
							if (scenario.mode === "http" || scenario.mode === "hook") return new Response(JSON.stringify(quota), { status: 429 });
							if (scenario.mode === "partial") return sse([
								{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
								{ type: "response.content_part.added", item_id: "m", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
								{ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "partial" }, quota,
							]);
							if (scenario.mode === "raw-usage") return sse([{ type: "response.failed", response: { error: quota.error, usage: { input_tokens: 3 } } }]);
							if (scenario.mode === "thinking") return sse([
								{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r", summary: [] } },
								{ type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
								{ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "thought" }, quota,
							]);
							if (scenario.mode === "tool") return sse([
								{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "fixture", arguments: "" } },
								{ type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"x\":" }, quota,
							]);
							if (scenario.mode === "malformed") return sse([{ type: "response.created", response: { id: "m" } }]);
							return sse([quota]);
						}
						return sse([scenario.mode === "empty" ? { ...complete, response: { ...complete.response, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } } : complete]);
					},
				};
				const model = scenario.direct ? ctx.modelRegistry.find(scenario.direct, scenario.direct === "github-copilot" ? "claude-sonnet-5.5" : "gpt-5.6-luna") : ctx.model;
				if (scenario.lowLevelReview) {
					const result = await ctx.modelRegistry.stream(ctx.model, { messages: [] }, {}).result();
					assert.equal(result.stopReason, "error");
					assert.match(result.errorMessage, /streamSimple/);
				}
				const transcript = { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] };
				const stream = scenario.raw ? ctx.modelRegistry.stream(model, transcript, options) : ctx.modelRegistry.streamSimple(model, transcript, options);
				const events = [];
				for await (const event of stream) events.push(structuredClone(event));
				const result = await stream.result();
				assert.equal(events.filter(event => ["done", "error"].includes(event.type)).length, 1);
				assert.equal(events.filter(event => event.type === "start").length <= 1, true);
				assert.equal(requests.length, scenario.expected.length, JSON.stringify({ requests, result }));
				assert.deepEqual(requests.map(request => request.headers["chatgpt-account-id"] ?? "copilot"), scenario.expected);
				assert.equal(result.provider, scenario.answer);
				assert.equal(result.stopReason, scenario.stop ?? "stop", result.errorMessage);
				assert.equal(payloads.length, requests.length);
				assert.equal(responses.length, requests.length - (scenario.expected.includes("copilot") && scenario.mode !== "copilot-ok" ? 1 : 0));
				for (const payload of payloads.filter(item => item.provider.startsWith("openai-codex:"))) {
					assert.equal(payload.payload.reasoning.effort, scenario.wireThinking ?? scenario.thinking ?? "high");
					if (scenario.raw) { assert.equal(payload.payload.text.verbosity, "high"); assert.equal(payload.payload.tool_choice, "required"); }
				}
				for (const request of requests) {
					assert.equal(request.headers["source-only"], scenario.direct === "github-copilot" ? "must-not-cross" : undefined, "account switches discard source auth headers");
					assert.equal(request.headers["account-config"], request.headers["chatgpt-account-id"] ?? "copilot");
					if (request.headers["chatgpt-account-id"] === "personal") assert.equal(request.headers.authorization, `Bearer ${scenario.personalToken}`);
					if (request.headers["chatgpt-account-id"] === "work") assert.equal(request.headers.authorization, `Bearer ${scenario.workToken}`);
				}
				if (scenario.mode === "partial") assert.ok(result.content.some(part => part.type === "text" && part.text === "partial"));
				if (scenario.mode === "thinking") assert.ok(result.content.some(part => part.type === "thinking" && part.thinking === "thought"));
				if (scenario.mode === "tool") assert.ok(result.content.some(part => part.type === "toolCall"));
				if (result.stopReason === "stop") assert.equal(result.usage.input, scenario.mode === "empty" ? 0 : 2);
				pi.appendEntry("routing-test", { result, events, requests, rawEvents });
			}
			assert.equal(external, 0);
			assert.equal(readFileSync(join(getAgentDir(), "auth.json"), "utf8"), before, "credentials are not modified");
			pi.appendEntry("routing-probe-ready", { model: ctx.model.provider, external });
		} catch (error) {
			pi.appendEntry("routing-test-error", { message: error.message, stack: error.stack });
		}
	});
}
