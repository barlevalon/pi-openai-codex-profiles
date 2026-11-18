import assert from "node:assert/strict";
import test from "node:test";
import { budgetOf, codexModelId, copilotModelId } from "../targets.ts";

test("readable model namespaces and target-derived budgets retain physical identity", () => {
  const codex = codexModelId("native-codex-id");
  const copilot = copilotModelId("native-copilot-id");
  assert.equal(codex, "native-codex-id");
  assert.equal(copilot, "native-copilot-id");
  for (const account of ["work", "personal"]) {
    const target = { service: "codex", account, model: codex };
    assert.deepEqual(budgetOf(target), { service: "codex", account });
    assert.deepEqual(budgetOf({ ...target, model: codexModelId("another-native-id") }), budgetOf(target));
    assert.ok(Object.isFrozen(budgetOf(target)));
  }
  assert.deepEqual(budgetOf({ service: "copilot-review", model: copilot }), { service: "copilot-review" });
});

test("model namespaces reject malformed native IDs without requiring catalog membership", () => {
  for (const bind of [codexModelId, copilotModelId]) {
    for (const id of ["", " padded", "padded ", "bad\u0000id", "bad\nid"]) assert.throws(() => bind(id), /Invalid/);
    assert.equal(bind("custom/direct-model"), "custom/direct-model");
  }
});
