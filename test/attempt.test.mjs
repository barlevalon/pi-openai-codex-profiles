import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeProbe } from "./native-probe.mjs";

for (const [mode, count, ending, evidence] of [
  ["hidden-quota", 2, "stop", 1],
  ["internal-quota", 2, "stop", 1],
  ["last-internal-quota", 1, "error", 1],
  ["empty-success", 1, "stop", 0],
  ["empty-success-after-quota", 1, "stop", 1],
  ["pre-aborted", 0, "aborted", 0],
  ["caller-abort", 1, "aborted", 1],
  ["caller-and-internal", 1, "aborted", 1],
  ["cleanup-caller-abort", 1, "aborted", 1],
  ["provider-abort", 1, "aborted", 1],
  ["text", 1, "error", 1],
  ["thinking", 1, "error", 1],
  ["tool", 1, "error", 1],
  ["terminal-usage", 1, "error", 1],
  ["terminal-cost", 1, "error", 1],
  ["provider-cost-marker", 1, "error", 1],
  ["raw-usage", 1, "error", 1],
  ["raw-output", 1, "error", 1],
  ["mutated-usage", 1, "error", 1],
  ["mutated-intro", 1, "error", 0],
  ["mutated-quota", 2, "stop", 1],
  ["hook-before-quota", 1, "error", 1],
  ["hook-after-quota", 1, "error", 1],
  ["event-hook", 1, "error", 1],
  ["missing-terminal", 1, "error", 0],
  ["missing-after-output", 1, "error", 0],
]) test(`attempt settlement ${mode}`, { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-attempt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await nativeProbe("attempt", directory, directory, { DOMAIN_MODE: mode });
  assert.equal(result.calls.length, count);
  assert.equal(result.stopReason, ending);
  assert.equal(result.provider, count === 2 || mode === "last-internal-quota" ? "openai-codex:personal" : "openai-codex:work");
  assert.equal(result.observations.length, evidence);
  assert.equal(result.callerAborted, ["pre-aborted", "caller-abort", "caller-and-internal", "cleanup-caller-abort"].includes(mode));
  if (count === 2) assert.deepEqual(result.calls, ["openai-codex:work", "openai-codex:personal"]);
  if (mode === "terminal-usage") assert.equal(result.usage.input, 2);
  if (mode === "terminal-cost") assert.equal(result.usage.cost.total, 0.1);
  if (mode === "provider-cost-marker") assert.equal(result.usage.cost.totalFromProvider, true);
});
