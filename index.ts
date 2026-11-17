import { getSupportedThinkingLevels, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { quotaStore } from "./quota.ts";
import { PERSONAL, POLICY, REVIEW, WORK, routing } from "./routing.ts";

export default function (pi: ExtensionAPI) {
	const builtins = builtinProviders();
	const codex = builtins.find(({ id }) => id === "openai-codex")!;
	const copilot = builtins.find(({ id }) => id === "github-copilot")!;
	let current: ExtensionContext | undefined;
	const notice = (message: string) => {
		if (current?.hasUI) current.ui.notify(message, "warning");
		else console.error(message);
	};
	const route = routing(codex, copilot, () => current, quotaStore(join(getAgentDir(), "codex-routing"), notice), notice);
	for (const id of [PERSONAL, WORK]) {
		const remap = () => codex.getModels().map(model => ({ ...model, provider: id }));
		const oauth = codex.auth.oauth!;
		const provider: Provider = {
			...codex, id, name: `${codex.name} (${id === WORK ? "work" : "personal"})`,
			getModels: remap,
			...(codex.getAllModels ? { getAllModels: () => codex.getAllModels!().map(model => ({ ...model, provider: id })) } : {}),
			auth: {
				...codex.auth,
				oauth: id === WORK ? {
					...oauth,
					async refresh(...args) { route.guardWork(); return oauth.refresh(...args); },
					async toAuth(...args) { route.guardWork(); return oauth.toAuth(...args); },
				} : oauth,
			},
			stream: (model, context, options) => route.stream(model, context, options, false),
			streamSimple: (model, context, options) => route.stream(model, context, options),
		};
		pi.registerProvider(provider);
	}
	for (const model of codex.getModels()) {
		pi.registerVirtualModel({
			provider: POLICY, id: model.id, name: `${model.name} (repo policy)`,
			thinkingLevels: getSupportedThinkingLevels(model), input: model.input,
			contextWindow: model.contextWindow, maxTokens: model.maxTokens,
			route(request) {
				return { model: route.target(route.plan()[0], model.id), thinkingLevel: request.thinkingLevel };
			},
		});
	}
	const opus = copilot.getModels().find(model => model.id === "claude-opus-5.5")!;
	const fallback = codex.getModels().find(model => model.id === "gpt-6.1-sol")!;
	const levels = getSupportedThinkingLevels(opus).filter(level => getSupportedThinkingLevels(fallback).includes(level));
	const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const reviewModel = {
		...opus, provider: REVIEW, name: "Opus review with Codex quota fallback",
		input: opus.input.filter(input => fallback.input.includes(input)),
		contextWindow: Math.min(opus.contextWindow, fallback.contextWindow),
		maxTokens: Math.min(opus.maxTokens, fallback.maxTokens),
		thinkingLevelMap: Object.fromEntries(allLevels.map(level => [level, levels.includes(level) ? opus.thinkingLevelMap?.[level] ?? level : null])),
	};
	pi.registerProvider({
		id: REVIEW, name: "Profile review", getModels: () => [reviewModel], getAllModels: () => [reviewModel],
		auth: { apiKey: { name: "Review routing", async resolve() { return { auth: {}, source: "routing" }; } } },
		stream() { throw new Error("profile-review requires provider-neutral streamSimple options"); },
		streamSimple: (model, context, options) => route.stream(model, context, options, true, true),
	});
	async function normalize(ctx: ExtensionContext) {
		current = ctx;
		if (ctx.model?.provider !== PERSONAL && ctx.model?.provider !== WORK) return;
		const model = ctx.modelRegistry.find(POLICY, ctx.model.id);
		if (!model) throw new Error(`Missing Codex policy model: ${ctx.model.id}`);
		const thinking = pi.getThinkingLevel();
		if (!await pi.setModel(model)) throw new Error("Cannot select Codex repo policy");
		pi.setThinkingLevel(thinking);
	}
	pi.on("session_start", (_event, ctx) => normalize(ctx));
	pi.on("model_select", (_event, ctx) => normalize(ctx));
	pi.on("session_tree", (_event, ctx) => normalize(ctx));
	pi.on("session_shutdown", () => { current = undefined; });
	let reviewUsedCodex = false;
	pi.on("before_agent_start", () => { reviewUsedCodex = false; });
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (ctx.model?.provider !== REVIEW || message.role !== "assistant") return;
		if ((message.provider === PERSONAL || message.provider === WORK) && message.stopReason !== "error" && message.stopReason !== "aborted") reviewUsedCodex = true;
		if (ctx.mode !== "json" && ctx.mode !== "print") return;
		if (!reviewUsedCodex || (message.stopReason !== "stop" && message.stopReason !== "length")) return;
		return {
			message: {
				...message,
				content: [{ type: "text", text: "Routing notice. This review used Codex after Copilot quota exhaustion. Cross-family diversity is reduced." }, ...message.content],
			},
		};
	});
}
