import type { ApiStreamOptions, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Policy, Profile } from "../policy.ts";
import type { QuotaLedger } from "../quota.ts";
import type { DirectObservation } from "../quota-protocol.ts";
import { nativeProviders } from "../native-guards.ts";
import { COPILOT_ACCOUNT, PERSONAL_ACCOUNT, WORK_ACCOUNT } from "../targets.ts";
import type { AccountOrder, CodexModelId, CopilotModelId, ModelTarget, ProviderAccount } from "../targets.ts";
import extension from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

declare const policy: Policy;
declare const codexId: CodexModelId;
declare const copilotId: CopilotModelId;
declare const observation: DirectObservation;
declare const ledger: QuotaLedger;
declare const model: Model<"openai-codex-responses">;
declare const anthropic: Model<"anthropic-messages">;
declare const transcript: TranscriptContext;
declare const pi: ExtensionAPI;
const { codex, copilot } = nativeProviders();
const raw: Provider<"openai-codex-responses">["stream"] = codex.stream;
const simple: Provider["streamSimple"] = copilot.streamSimple;
raw(model, transcript, { reasoningEffort: "high", toolChoice: "required" });
simple(anthropic, transcript, { reasoning: "high", toolChoice: "auto" });
copilot.stream(anthropic, transcript, { thinkingEnabled: true });
ledger.observeDirect(observation);
const workTarget: ModelTarget = { account: WORK_ACCOUNT, modelId: codexId };
const copilotTarget: ModelTarget = { account: COPILOT_ACCOUNT, modelId: copilotId };
const personal: Profile = { name: "personal", accounts: [PERSONAL_ACCOUNT] };
// @ts-expect-error COPILOT_IS_WORK
const copilotInPersonal: Profile = { name: "personal", accounts: [COPILOT_ACCOUNT] };
const work: Profile = { name: "work", accounts: [WORK_ACCOUNT, COPILOT_ACCOUNT], criteria: { githubOwners: [], roots: ["/example/work"] } };
const rawOptions: ApiStreamOptions<"openai-codex-responses"> = { reasoningEffort: "high" };
const simpleOptions: SimpleStreamOptions = { reasoning: "high" };
extension(pi);

// @ts-expect-error WRONG_BUDGET
const mismatchedAccount: ProviderAccount = { credential: "github-copilot", budget: "work-codex" };
// @ts-expect-error CODEX_NAMESPACE
const foreignCodex: ModelTarget = { account: WORK_ACCOUNT, modelId: copilotId };
// @ts-expect-error COPILOT_NAMESPACE
const foreignCopilot: ModelTarget = { account: COPILOT_ACCOUNT, modelId: codexId };
// @ts-expect-error WORK_MEMBERSHIP
const workInPersonal: Profile = { name: "personal", accounts: [WORK_ACCOUNT] };
// @ts-expect-error PERSONAL_MEMBERSHIP
const personalInWork: Profile = { name: "work", accounts: [PERSONAL_ACCOUNT], criteria: { githubOwners: [], roots: ["/example/work"] } };
// @ts-expect-error WORK_CRITERIA
const noCriteria: Profile = { name: "work", accounts: [WORK_ACCOUNT] };
// @ts-expect-error CODEX_ORDER
const copilotOrder: Policy = { profiles: [], codexOrder: [COPILOT_ACCOUNT] };
// @ts-expect-error WORK_ONLY
const workOnly: AccountOrder = ["work"];
// @ts-expect-error RAW_STRING_NAMESPACE
const rawId: CodexModelId = "unbound-native-id";
// @ts-expect-error RAW_CODEX_OPTIONS
raw(model, transcript, { thinkingEnabled: true });
// @ts-expect-error RAW_CODEX_MODEL
raw(anthropic, transcript, { reasoningEffort: "high" });
// @ts-expect-error RAW_COPILOT_OPTIONS
copilot.stream(anthropic, transcript, { reasoningEffort: "high" });
// @ts-expect-error SIMPLE_RAW_OPTIONS
simple(anthropic, transcript, { reasoningEffort: "high" });
// @ts-expect-error SIMPLE_TOOL_CHOICE
simple(anthropic, transcript, { toolChoice: "required" });
// @ts-expect-error FORGED_OBSERVATION
ledger.observeDirect({ account: WORK_ACCOUNT, until: Date.now() });
// @ts-expect-error RETARGETED_OBSERVATION
ledger.observeDirect({ ...observation, account: WORK_ACCOUNT });
// @ts-expect-error REWRITTEN_OBSERVATION
ledger.observeDirect({ ...observation, until: observation.until + 1000 });
// @ts-expect-error IMMUTABLE_OBSERVATION
observation.until = Date.now();
// @ts-expect-error SCALAR_OBSERVATION
ledger.observeDirect(Date.now());
// @ts-expect-error LEGACY_OBSERVE
ledger.observe("work-codex", Date.now());
// @ts-expect-error FORGED_INGRESS
extension(pi, { account: WORK_ACCOUNT, apiKey: "fake" });
// @ts-expect-error PRIVATE_ATTEMPT
import { finish } from "../routing.ts";
