import { unpaddedText } from "./identifiers.ts";
import type { Policy } from "./policy.ts";
import type { RepoScope } from "./scope.ts";

export const PERSONAL_ACCOUNT = Object.freeze({ credential: "openai-codex:personal", budget: "personal-codex" } as const);
export const WORK_ACCOUNT = Object.freeze({ credential: "openai-codex:work", budget: "work-codex" } as const);
export const COPILOT_ACCOUNT = Object.freeze({ credential: "github-copilot", budget: "copilot-review" } as const);
export type CodexAccount = typeof PERSONAL_ACCOUNT | typeof WORK_ACCOUNT;
export type ProviderAccount = CodexAccount | typeof COPILOT_ACCOUNT;
export type Budget = ProviderAccount["budget"];
export type AccountOrder = readonly ["personal"] | readonly ["personal", "work"] | readonly ["work", "personal"];

declare const codexNamespace: unique symbol;
declare const copilotNamespace: unique symbol;
export type CodexModelId = string & { readonly [codexNamespace]: true };
export type CopilotModelId = string & { readonly [copilotNamespace]: true };
export type CodexTarget = Readonly<{ account: CodexAccount; modelId: CodexModelId }>;
export type ModelTarget = CodexTarget | Readonly<{ account: typeof COPILOT_ACCOUNT; modelId: CopilotModelId }>;
export type Candidates = readonly [ModelTarget, ...ModelTarget[]];
export type Intent = Readonly<{ kind: "codex-policy"; modelId: CodexModelId }> | Readonly<{ kind: "review" }>;
export type Eligibility = Readonly<{ kind: "eligible"; targets: Candidates }>
	| Readonly<{ kind: "unavailable"; reason: "profile-denied" | "unowned" | "not-configured" }>;
export type BudgetState = Readonly<{ kind: "available" }> | Readonly<{ kind: "cooling"; until: number }> | Readonly<{ kind: "unreadable" }>;
export type Selection = Readonly<{ kind: "selected"; targets: Candidates }>
	| Readonly<{ kind: "unavailable"; reason: "all-cooling" | "budget-unreadable" }>;

export function codexModelId(value: string): CodexModelId {
	if (!unpaddedText(value)) throw new Error("Invalid Codex model ID");
	return value as CodexModelId;
}

export function copilotModelId(value: string): CopilotModelId {
	if (!unpaddedText(value)) throw new Error("Invalid Copilot model ID");
	return value as CopilotModelId;
}

export function accountOwner(policy: Policy, account: ProviderAccount) {
	return policy.profiles.find(profile => profile.accounts.some(member => member.credential === account.credential));
}

export function accountEligible(policy: Policy, account: ProviderAccount, scope: RepoScope): boolean {
	const owner = accountOwner(policy, account);
	if (!owner) return false;
	return owner.name === "personal" || scope === "eligible";
}

export function eligibleCandidates(policy: Policy, scope: RepoScope, intent: Intent): Eligibility {
	const targets: ModelTarget[] = [];
	let modelId: CodexModelId;
	if (intent.kind === "review") {
		if (!policy.review) return { kind: "unavailable", reason: "not-configured" };
		const owner = accountOwner(policy, COPILOT_ACCOUNT);
		if (!owner) return { kind: "unavailable", reason: "unowned" };
		if (!accountEligible(policy, COPILOT_ACCOUNT, scope)) return { kind: "unavailable", reason: "profile-denied" };
		targets.push(Object.freeze({ account: COPILOT_ACCOUNT, modelId: policy.review.primary }));
		modelId = policy.review.fallback;
	} else modelId = intent.modelId;
	for (const account of policy.codexOrder) {
		if (accountEligible(policy, account, scope)) targets.push(Object.freeze({ account, modelId }));
	}
	const [first, ...rest] = targets;
	if (!first) return { kind: "unavailable", reason: "profile-denied" };
	return { kind: "eligible", targets: Object.freeze([first, ...rest]) };
}

export function selectTargets(candidates: Candidates, budgets: ReadonlyMap<Budget, BudgetState>): Selection {
	const available: ModelTarget[] = [];
	for (const target of candidates) {
		const state = budgets.get(target.account.budget);
		if (state?.kind === "unreadable") {
			if (target.account.credential === WORK_ACCOUNT.credential) continue;
			return { kind: "unavailable", reason: "budget-unreadable" };
		}
		if (state?.kind === "available") available.push(target);
	}
	const [first, ...rest] = available;
	if (!first) return { kind: "unavailable", reason: "all-cooling" };
	return { kind: "selected", targets: Object.freeze([first, ...rest]) };
}
