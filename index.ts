import { getSupportedThinkingLevels, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { quotaStore } from "./quota.ts";
import { PERSONAL, POLICY, REVIEW, REVIEW_NOTICE, WORK, routing } from "./routing.ts";
import { loadPolicy } from "./policy.ts";
import { reviewModel } from "./review.ts";

export default function (pi: ExtensionAPI) {
	const builtins = builtinProviders();
	const codex = builtins.find(({ id }) => id === "openai-codex")!;
	const copilot = builtins.find(({ id }) => id === "github-copilot")!;
	let current: ExtensionContext | undefined;
	const notice = (message: string) => {
		if (current?.hasUI) current.ui.notify(message, "warning");
		else console.error(message);
	};
	const policy = loadPolicy(getAgentDir(), notice);
	const route = routing(codex, copilot, () => current, quotaStore(join(getAgentDir(), "codex-routing"), notice), notice, policy);
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
				return { model: route.target(route.plan(model.id)[0]), thinkingLevel: request.thinkingLevel };
			},
		});
	}
	if (policy.review) {
		try {
			const model = reviewModel(policy.review, copilot.getModels().find(model => model.id === policy.review!.copilotModel), codex.getModels().find(model => model.id === policy.review!.codexFallbackModel));
			pi.registerProvider({
				id: REVIEW, name: "Profile review", getModels: () => [model], getAllModels: () => [model],
				auth: { apiKey: { name: "Review routing", async resolve() { return { auth: {}, source: "routing" }; } } },
				stream() { throw new Error("profile-review requires provider-neutral streamSimple options"); },
				streamSimple: (source, context, options) => route.stream(source, context, options, true, true),
			});
		} catch {
			pi.registerVirtualModel({
				provider: REVIEW, id: policy.review.copilotModel, name: "Configured review unavailable",
				route() { throw new Error("Configured review targets are unavailable or incompatible"); },
			});
		}
	}
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
				content: [{ type: "text", text: REVIEW_NOTICE }, ...message.content],
			},
		};
	});
}
