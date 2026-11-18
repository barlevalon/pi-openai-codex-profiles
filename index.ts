import { nativeProviders } from "./native-guards.ts";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createQuotaLedger } from "./quota.ts";
import { PERSONAL, POLICY, REVIEW, REVIEW_NOTICE, WORK, createNativeRouting } from "./routing.ts";
import { loadPolicy } from "./policy.ts";
import { reviewContribution, type Contribution } from "./review.ts";

export default function (pi: ExtensionAPI) {
	const { codex, copilot } = nativeProviders();
	let current: ExtensionContext | undefined;
	const notice = (message: string) => {
		if (current?.hasUI) current.ui.notify(message, "warning");
		else console.error(message);
	};
	const policy = loadPolicy(getAgentDir(), notice);
	const routing = createNativeRouting(codex, copilot, () => current, createQuotaLedger(join(getAgentDir(), "codex-routing"), notice), notice, policy);
	for (const provider of routing.providers) pi.registerProvider(provider);
	for (const selection of routing.selections) pi.registerVirtualModel(selection);
	async function normalize(ctx: ExtensionContext) {
		current = ctx;
		await ctx.modelRegistry.refresh({ allowNetwork: false });
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
	let contribution: Contribution = "none";
	pi.on("before_agent_start", () => { contribution = "none"; });
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (ctx.model?.provider !== REVIEW || message.role !== "assistant") return;
		if (message.provider === PERSONAL || message.provider === WORK || message.provider === "github-copilot") contribution = reviewContribution(contribution, {
			answerer: message.provider === "github-copilot" ? "copilot" : "codex", ending: message.stopReason === "toolUse" ? "tool" : message.stopReason,
		});
		if (ctx.mode !== "json" && ctx.mode !== "print") return;
		if (contribution !== "codex" || (message.stopReason !== "stop" && message.stopReason !== "length")) return;
		return {
			message: {
				...message,
				content: [{ type: "text", text: REVIEW_NOTICE }, ...message.content],
			},
		};
	});
}
