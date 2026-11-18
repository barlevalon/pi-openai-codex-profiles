declare const codexId: unique symbol;
declare const copilotId: unique symbol;

export type Account = "personal" | "work";
export type CodexModelId = string & { readonly [codexId]: true };
export type CopilotModelId = string & { readonly [copilotId]: true };
export type AccountOrder = readonly ["personal"] | readonly ["personal", "work"] | readonly ["work", "personal"];

export type CodexTarget<A extends Account = Account> = Readonly<{
	service: "codex";
	account: A;
	model: CodexModelId;
}>;
export type ReviewPrimary = Readonly<{ service: "copilot-review"; model: CopilotModelId }>;
export type Target = CodexTarget | ReviewPrimary;
export type Budget = Readonly<{ service: "codex"; account: Account }> | Readonly<{ service: "copilot-review" }>;

export function codexModelId(value: string): CodexModelId {
	if (!value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Codex model ID");
	return value as CodexModelId;
}

export function copilotModelId(value: string): CopilotModelId {
	if (!value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Copilot model ID");
	return value as CopilotModelId;
}

export function budgetOf<A extends Account>(target: CodexTarget<A>): Readonly<{ service: "codex"; account: A }>;
export function budgetOf(target: ReviewPrimary): Readonly<{ service: "copilot-review" }>;
export function budgetOf(target: Target): Budget;
export function budgetOf(target: Target): Budget {
	return target.service === "codex"
		? Object.freeze({ service: "codex", account: target.account })
		: Object.freeze({ service: "copilot-review" });
}

export type BudgetState =
	| Readonly<{ kind: "available" }>
	| Readonly<{ kind: "cooling"; until: number }>
	| Readonly<{ kind: "unreadable" }>;
export interface BudgetView {
	readonly personal: BudgetState;
	readonly work: BudgetState;
	readonly review: BudgetState;
}
