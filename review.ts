import { getSupportedThinkingLevels, type Provider } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import type { ReviewBinding } from "./policy.ts";

type Model = ReturnType<Provider["getModels"]>[number];

function inputLimits(model: Model) {
	const { images, ...limits } = model.inputLimits ?? {};
	const { resize, ...imageLimits } = images ?? {};
	return { ...limits, images: { ...imageLimits, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80, ...resize } } };
}

export function reviewModel(binding: ReviewBinding | undefined, primary: Model | undefined, fallback: Model | undefined, advertised?: Model): Model {
	if (!binding || !primary || !fallback || primary.type !== "chat" || fallback.type !== "chat" || primary.id !== binding.primary || fallback.id !== binding.fallback) throw new Error("Configured review targets are unavailable");
	const levels = getSupportedThinkingLevels(primary).filter(level => getSupportedThinkingLevels(fallback).includes(level));
	const input = primary.input.filter(kind => fallback.input.includes(kind));
	if (!levels.length || !input.includes("text") || !isDeepStrictEqual(inputLimits(primary), inputLimits(fallback))) throw new Error("Configured review targets have incompatible capabilities");
	if (advertised && (advertised.contextWindow > Math.min(primary.contextWindow, fallback.contextWindow)
		|| advertised.maxTokens > Math.min(primary.maxTokens, fallback.maxTokens)
		|| advertised.input.some(kind => !input.includes(kind))
		|| getSupportedThinkingLevels(advertised).some(level => !levels.includes(level))
		|| !isDeepStrictEqual(inputLimits(advertised), inputLimits(primary)))) throw new Error("Configured review targets have incompatible capabilities");
	const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	return {
		...primary, provider: "profile-review", name: "Configured review with quota fallback", input,
		inputLimits: inputLimits(primary),
		contextWindow: Math.min(primary.contextWindow, fallback.contextWindow),
		maxTokens: Math.min(primary.maxTokens, fallback.maxTokens),
		thinkingLevelMap: Object.fromEntries(allLevels.map(level => [level, levels.includes(level) ? primary.thinkingLevelMap?.[level] ?? level : null])),
	};
}

export type Contribution = "none" | "codex";
export type ReviewTurn = Readonly<{
	answerer: "copilot" | "codex";
	ending: "pending" | "stop" | "length" | "tool" | "deferred" | "error" | "aborted";
}>;

export function reviewContribution(previous: Contribution, turn: ReviewTurn): Contribution {
	return turn.answerer === "codex" && turn.ending !== "error" && turn.ending !== "aborted" ? "codex" : previous;
}
