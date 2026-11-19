import { readBoundedFile } from "./bounded-file.ts";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { asciiAlphanumeric, githubOwner, unpaddedText } from "./identifiers.ts";
import { COPILOT_ACCOUNT, PERSONAL_ACCOUNT, WORK_ACCOUNT, codexModelId, copilotModelId } from "./targets.ts";
import type { CodexAccount, CodexModelId, CopilotModelId } from "./targets.ts";

export type WorkScope = Readonly<{ githubOwners: readonly string[]; roots: readonly string[] }>;
export type Profile =
	| Readonly<{ name: "personal"; accounts: readonly (typeof PERSONAL_ACCOUNT)[] }>
	| Readonly<{ name: "work"; criteria: WorkScope; accounts: readonly (typeof WORK_ACCOUNT | typeof COPILOT_ACCOUNT)[] }>;
export type ReviewBinding = Readonly<{ primary: CopilotModelId; fallback: CodexModelId }>;
export type Policy = Readonly<{ profiles: readonly Profile[]; codexOrder: readonly CodexAccount[]; review?: ReviewBinding }>;
const PERSONAL_ONLY: Policy = Object.freeze({
	profiles: Object.freeze([Object.freeze({ name: "personal", accounts: Object.freeze([PERSONAL_ACCOUNT]) })]),
	codexOrder: Object.freeze([PERSONAL_ACCOUNT]),
});
const MAX_POLICY_BYTES = 64 * 1024;
const rawPolicySchema = Type.Object({
	version: Type.Literal(1),
	accountOrder: Type.Union([
		Type.Tuple([Type.Literal("personal")]),
		Type.Tuple([Type.Literal("personal"), Type.Literal("work")]),
		Type.Tuple([Type.Literal("work"), Type.Literal("personal")]),
	]),
	copilotProfile: Type.Optional(Type.Literal("work")),
	work: Type.Optional(Type.Object({
		githubOwners: Type.Optional(Type.Array(Type.String())),
		roots: Type.Optional(Type.Array(Type.String())),
	}, { additionalProperties: false })),
	review: Type.Optional(Type.Object({
		copilotModel: Type.String(),
		codexFallbackModel: Type.String(),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

function configuredModelId(value: string): boolean {
	if (!value || !asciiAlphanumeric(value[0])) return false;
	return [...value].every(character => asciiAlphanumeric(character) || "._:-".includes(character));
}

export function parsePolicy(value: unknown): Policy {
	if (!Check(rawPolicySchema, value)) throw new Error("Invalid routing policy structure");
	const data = value;
	const order = data.accountOrder;
	const owners = data.work?.githubOwners ?? [];
	const roots = data.work?.roots ?? [];
	if (owners.some(owner => !githubOwner(owner))) throw new Error("work.githubOwners contains an invalid GitHub owner");
	if (roots.some(root => !unpaddedText(root) || !isAbsolute(root) && !root.startsWith("~/"))) throw new Error("work.roots must contain absolute paths or leading ~/ paths");
	const work = data.work === undefined ? undefined : Object.freeze({
		githubOwners: Object.freeze(owners.map(owner => owner.toLowerCase())),
		roots: Object.freeze(roots.map(root => root.startsWith("~/") ? join(homedir(), root.slice(2)) : root)),
	});
	let review: ReviewBinding | undefined;
	if (data.review !== undefined) {
		if (!configuredModelId(data.review.copilotModel)) throw new Error("review.copilotModel must be an exact native model ID");
		if (!configuredModelId(data.review.codexFallbackModel)) throw new Error("review.codexFallbackModel must be an exact native model ID");
		review = Object.freeze({ primary: copilotModelId(data.review.copilotModel), fallback: codexModelId(data.review.codexFallbackModel) });
	}
	const workCodex = order.some(account => account === "work");
	const workCopilot = data.copilotProfile === "work";
	if (workCodex || workCopilot) {
		if (!work || work.githubOwners.length + work.roots.length === 0) throw new Error("work requires nonempty githubOwners or roots for every work-owned account");
	}
	const profiles: Profile[] = [...PERSONAL_ONLY.profiles];
	if (work && (workCodex || workCopilot)) {
		const accounts: (typeof WORK_ACCOUNT | typeof COPILOT_ACCOUNT)[] = [];
		if (workCodex) accounts.push(WORK_ACCOUNT);
		if (workCopilot) accounts.push(COPILOT_ACCOUNT);
		profiles.push(Object.freeze({ name: "work", criteria: work, accounts: Object.freeze(accounts) }));
	}
	return Object.freeze({
		profiles: Object.freeze(profiles),
		codexOrder: Object.freeze(order.map(account => account === "personal" ? PERSONAL_ACCOUNT : WORK_ACCOUNT)),
		...(review === undefined ? {} : { review }),
	});
}

export function loadPolicy(agentDir: string, notice: (message: string) => void): Policy {
	try {
		const buffer = readBoundedFile(join(agentDir, "codex-routing-policy.json"), MAX_POLICY_BYTES);
		return parsePolicy(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") notice("Cannot load Codex routing policy. Using personal only with review disabled.");
		return PERSONAL_ONLY;
	}
}
