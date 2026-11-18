import assert from "node:assert/strict";
import test from "node:test";
import { COPILOT_ACCOUNT, PERSONAL_ACCOUNT, WORK_ACCOUNT, accountEligible, codexModelId, copilotModelId, eligibleCandidates, selectTargets } from "../targets.ts";
import { parsePolicy } from "../policy.ts";

const modelId = codexModelId("native-codex-id");
const available = { kind: "available" };
const unreadable = { kind: "unreadable" };
const cooling = { kind: "cooling", until: 1000 };

test("canonical accounts correlate credential identity and independent quota history", () => {
  assert.deepEqual(PERSONAL_ACCOUNT, { credential: "openai-codex:personal", budget: "personal-codex" });
  assert.deepEqual(WORK_ACCOUNT, { credential: "openai-codex:work", budget: "work-codex" });
  assert.deepEqual(COPILOT_ACCOUNT, { credential: "github-copilot", budget: "copilot-review" });
  for (const account of [PERSONAL_ACCOUNT, WORK_ACCOUNT, COPILOT_ACCOUNT]) assert.ok(Object.isFrozen(account));
});

test("model namespaces reject malformed native IDs without requiring catalog membership", () => {
  for (const bind of [codexModelId, copilotModelId]) {
    const controls = [...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)), "\u007f"];
    for (const id of ["", " padded", "padded ", ...controls.map(control => `bad${control}id`)]) assert.throws(() => bind(id), /Invalid/);
    for (const id of ["custom/direct-model", "模型", "two internal spaces", "native.Model_1:variant-2"]) assert.equal(bind(id), id);
  }
});

test("profile membership governs Copilot independently of Codex order", () => {
  for (const copilotProfile of [undefined, "work"]) {
    const policy = parsePolicy({ version: 1, accountOrder: ["personal"], copilotProfile, work: { roots: ["/example/work"] } });
    for (const scope of ["eligible", "other", "unknown"]) {
      assert.equal(accountEligible(policy, COPILOT_ACCOUNT, scope), copilotProfile === "work" && scope === "eligible");
      assert.equal(accountEligible(policy, { ...COPILOT_ACCOUNT }, scope), accountEligible(policy, COPILOT_ACCOUNT, scope));
      assert.equal(accountEligible(policy, WORK_ACCOUNT, scope), false);
    }
  }
});

test("pure eligibility denies the work review primary before selecting fallback budgets", () => {
  const policy = parsePolicy({ version: 1, accountOrder: ["personal"], copilotProfile: "work", work: { githubOwners: ["example-org"] }, review: { copilotModel: "native-primary", codexFallbackModel: modelId } });
  for (const scope of ["other", "unknown"]) assert.deepEqual(eligibleCandidates(policy, scope, { kind: "review" }), { kind: "unavailable", reason: "profile-denied" });
  const result = eligibleCandidates(policy, "eligible", { kind: "review" });
  assert.deepEqual(result.targets.map(target => target.account), [COPILOT_ACCOUNT, PERSONAL_ACCOUNT]);
});

test("candidate selection preserves order, skips cooling and unreadable work, and fails closed for other unreadable budgets", () => {
  for (const order of [["personal"], ["personal", "work"], ["work", "personal"]]) {
    const policy = parsePolicy({ version: 1, accountOrder: order, work: { roots: ["/example/work"] } });
    for (const scope of ["eligible", "other", "unknown"]) {
      const candidates = eligibleCandidates(policy, scope, { kind: "codex-policy", modelId }).targets;
      for (const personal of [available, cooling, unreadable]) for (const work of [available, cooling, unreadable]) {
        const budgets = new Map([["personal-codex", personal], ["work-codex", work]]);
        const selected = selectTargets(candidates, budgets);
        if (personal === unreadable) assert.deepEqual(selected, { kind: "unavailable", reason: "budget-unreadable" });
        else {
          const expected = candidates.filter(target => budgets.get(target.account.budget) === available);
          if (!expected.length) assert.deepEqual(selected, { kind: "unavailable", reason: "all-cooling" });
          else assert.deepEqual(selected.targets, expected);
        }
      }
    }
  }
});

test("work Copilot requires selectors even with personal-only Codex priority", () => {
  for (const work of [undefined, {}, { githubOwners: [] }, { roots: [] }]) assert.throws(() => parsePolicy({ version: 1, accountOrder: ["personal"], copilotProfile: "work", work }), /work requires/);
  for (const copilotProfile of [null, "personal", "other", {}, 1]) assert.throws(() => parsePolicy({ version: 1, accountOrder: ["personal"], copilotProfile }), /Invalid routing policy structure/);
});
