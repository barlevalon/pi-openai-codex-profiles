import type { ApiStreamOptions, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Policy, ReviewBinding } from "../policy.ts";
import type { QuotaLedger, SharedCooldown } from "../quota.ts";
import { planCodex, planReview } from "../routing.ts";
import type { AttemptOutcome, DirectQuotaProof, NativeRouting, RetryableQuotaFailure, RoutePlan } from "../routing.ts";
import { budgetOf } from "../targets.ts";
import type { AccountOrder, BudgetView, CodexModelId, CodexTarget, CopilotModelId } from "../targets.ts";

declare const policy: Policy;
declare const codex: CodexModelId;
declare const anotherCodex: CodexModelId;
declare const copilot: CopilotModelId;
declare const binding: ReviewBinding;
declare const budgets: BudgetView;
declare const plan: RoutePlan;
declare const codexPlan: RoutePlan<CodexTarget>;
declare const proof: DirectQuotaProof;
declare const retry: RetryableQuotaFailure;
declare const ledger: QuotaLedger;
declare const diskObservation: SharedCooldown;
declare const native: NativeRouting;
declare const nativeCodex: Model<"openai-codex-responses">;
declare const context: TranscriptContext;
declare const rawOptions: ApiStreamOptions<"openai-codex-responses">;
declare const simpleOptions: SimpleStreamOptions;

const personal: CodexTarget<"personal"> = { service: "codex", account: "personal", model: codex };
const work: CodexTarget<"work"> = { service: "codex", account: "work", model: codex };
const workBudget: Readonly<{ service: "codex"; account: "work" }> = budgetOf(work);
planCodex(policy, codex, "eligible", budgets);
planReview(policy, "eligible", budgets);
ledger.observeDirect(proof);
const result: AttemptOutcome = retry;
const generalPlan: RoutePlan = codexPlan;
const provider: Provider = native.accountProvider("work");
const raw: Provider["stream"] = provider.stream;
const simple: Provider["streamSimple"] = provider.streamSimple;
raw(nativeCodex, context, rawOptions);
raw(nativeCodex, context, { reasoningEffort: "high", toolChoice: "required" });
simple(nativeCodex, context, simpleOptions);
if (native.reviewRegistration.kind === "ready") {
	const reviewSimple: Provider["streamSimple"] = native.reviewRegistration.provider.streamSimple;
	reviewSimple(nativeCodex, context, { reasoning: "high", toolChoice: "auto" });
	// @ts-expect-error Review accepts provider-neutral options, not Codex raw options.
	reviewSimple(nativeCodex, context, { reasoningEffort: "high" });
}
// @ts-expect-error A foreign policy's binding is not an independent planning input.
planReview(policy, binding, "eligible", budgets);
// @ts-expect-error A plan that may contain Copilot cannot enter Codex-specific raw execution.
const rawPlan: RoutePlan<CodexTarget> = plan;
// @ts-expect-error Copilot IDs cannot identify a Codex target.
const mismatchedFamily: CodexTarget = { service: "codex", account: "work", model: copilot };
// @ts-expect-error Raw strings have no model namespace provenance.
const unboundModel: CodexModelId = "some-native-id";
// @ts-expect-error Work's budget is derived, not independently paired.
const mismatchedBudget: Readonly<{ service: "codex"; account: "personal" }> = budgetOf(work);
// @ts-expect-error No function accepts an independently supplied quota key.
budgetOf(work, "personal-codex");
// @ts-expect-error Policy rejects a work-only order.
const workOnly: AccountOrder = ["work"];
// @ts-expect-error Review binding cannot be reconstructed with another fallback.
const reboundReview: ReviewBinding = { ...binding, fallback: anotherCodex };
// @ts-expect-error Copying a policy loses private construction authority.
const replacedOrder: Policy = { ...policy, accountOrder: ["work", "personal"] };
// @ts-expect-error Copying a plan loses private construction authority.
const duplicateTargets: RoutePlan = { ...plan, targets: [personal, personal] };
// @ts-expect-error Direct evidence cannot be retargeted by reconstruction.
const retargetedProof: DirectQuotaProof = { ...proof, target: work };
// @ts-expect-error Shared observations are not direct provider evidence.
ledger.observeDirect(diskObservation);
// @ts-expect-error An independent timestamp cannot establish provider evidence.
ledger.observeDirect(Date.now());
// @ts-expect-error Public fields cannot manufacture a retry outcome.
const manufacturedRetry: RetryableQuotaFailure = { kind: "quota-before-output", proof };
// @ts-expect-error Copying a retry outcome loses private settlement authority.
const copiedRetry: RetryableQuotaFailure = { ...retry };
// @ts-expect-error Arbitrary error labels cannot authorize advancement.
const genericErrorRetry: AttemptOutcome = { kind: "quota-before-output", proof };
// @ts-expect-error The private attempt owner is not exported.
import type { Attempt } from "../routing.ts";
// @ts-expect-error There is no independently injectable settlement API.
import { finish } from "../routing.ts";
// @ts-expect-error Native callbacks replace the boolean-mode routing API.
native.stream(nativeCodex, context, simpleOptions, true, true);
// @ts-expect-error The ledger cannot accept an independently paired storage key and reset.
ledger.observe("work-codex", Date.now());
// @ts-expect-error Neutral callbacks do not accept raw-only Codex tool choices.
simple(nativeCodex, context, { toolChoice: "required" });
