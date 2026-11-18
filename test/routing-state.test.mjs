import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeProbe } from "./native-probe.mjs";

test("repeated quota receipts all persist before one clean fallback", { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-routing-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await nativeProbe("attempt", directory, directory, { DOMAIN_MODE: "repeated-quota" });
  assert.deepEqual(result.calls, ["openai-codex:work", "openai-codex:personal"]);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.provider, "openai-codex:personal");
  assert.deepEqual(result.observations.map(account => account.budget), ["work-codex", "work-codex"]);
});
