import assert from "node:assert/strict";
import { probeTest } from "./native-probe.mjs";

probeTest("repeated quota receipts all persist before one clean fallback", "attempt", result => {
  assert.deepEqual(result.calls, ["openai-codex:work", "openai-codex:personal"]);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.provider, "openai-codex:personal");
  assert.deepEqual(result.observations.map(account => account.budget), ["work-codex", "work-codex"]);
}, { DOMAIN_MODE: "repeated-quota" });
