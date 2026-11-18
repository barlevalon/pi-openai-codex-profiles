import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export function hasOutput(message: AssistantMessage): boolean {
	if (message.content.length > 0) return true;
	if (Object.values(message.usage).some(value => typeof value === "number" && value > 0)) return true;
	return Object.values(message.usage.cost).some(value => Number(value) > 0);
}

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value as Record<string, unknown>;
}

function positiveUsage(value: unknown): boolean {
	const usage = record(value);
	if (!usage) return false;
	if (Object.values(usage).some(count => typeof count === "number" && count > 0)) return true;
	const cost = record(usage.cost);
	return !!cost && Object.values(cost).some(value => Number(value) > 0);
}

const RESPONSE_OUTPUT_EVENTS = new Set([
	"response.output_item.added", "response.content_part.added", "response.output_text.delta",
	"response.reasoning_text.delta", "response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta", "response.function_call_arguments.delta",
]);

export function rawHasOutput(value: unknown): boolean {
	const event = record(value);
	if (!event) return false;
	const response = record(event.response);
	const message = record(event.message);
	if (positiveUsage(event.usage) || positiveUsage(response?.usage) || positiveUsage(message?.usage)) return true;
	if (Array.isArray(response?.output) && response.output.length > 0) return true;
	if (Array.isArray(message?.content) && message.content.length > 0) return true;
	if (typeof event.type === "string" && RESPONSE_OUTPUT_EVENTS.has(event.type)) return true;
	if (event.type === "content_block_start" || event.type === "content_block_delta") return true;
	if (!Array.isArray(event.choices)) return false;
	for (const choice of event.choices) {
		const delta = record(record(choice)?.delta);
		if (!delta) continue;
		if (typeof delta.content === "string" && delta.content.length > 0) return true;
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
		if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	}
	return false;
}

export function failure(model: Model<Api>, error: unknown, aborted = false): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(),
		stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
